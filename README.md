<p align="center"><img src="design/icon.png" width="128" alt="Tusk's icon: an ivory tusk on an indigo tile" /></p>

# Tusk

Tusk is a fast desktop editor for PHP, Laravel, and Filament projects, for macOS, Windows, and Linux. It
aims for PhpStorm-class navigation and refactoring using only free, open-source
language servers. Its name comes from PHP's
elePHPant.

The app is built with Tauri 2 (Rust backend) and the Monaco editor.

## Status

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
| Git | Git asks for passwords and passphrases in a dialog (`gitOutput` in `src/git.ts`). Security keys that need a touch or a PIN, beyond ssh's own prompts, aren't supported. The log's branch graph shows only without filters, and a filtered log searches messages, not changed lines (`src/history.ts`). Grouping changed files by folder shows one row per folder, not nested folders (`src/commitview.ts`). **Apply Non-Conflicting Changes** merges whole conflict blocks, not single changes within a block that also has a true conflict (`resolveSimple` in `src/gitparse.ts`). The branches popup opens a branch's actions as a second popup rather than a submenu (`src/branches.ts`). |
| Find in files | Results stop at 20,000 matches, which **Settings > Limits** changes, so the replace preview lists only those; **Replace in All Files…** changes every matching file without a preview. Refactorings that search the project, such as Safe Delete, stop at 20,000 matches whatever the setting. |
| Test results | On PHPUnit 10 and later, a running test's file is found from its class name through `composer.json`'s PSR-4 folders, so a class outside them opens at a guess. A comparison's full expected and actual values come from the TeamCity log; where only PHPUnit's JUnit diff has them, the diff shows the changed lines and three lines around them. |
| Run configurations | In Sail, a configuration's environment variables and working directory don't reach the container (Compose services get the variables, and every container command runs in the project folder). Templates are each type's defaults; you can't edit them. A server that reopens with the project runs again as a plain command, not as its configuration, so the run widget doesn't show it as running. |
| Type hierarchy | Subtypes come from the PHP index, which loads `vendor` classes only as far as the project reaches them, so a package class the project never uses isn't listed. |
| Call hierarchy | Calls through dynamic names, such as `$this->$method()`, and calls on a value whose type the analyzer can't infer are missed. |
| TODO comments | The search stops at the Find in Files limit (20,000 matches by default), counted before those outside comments are dropped. |
| Test detection | `src/phptests.ts` reads tests with regexes over the code outside comments, so a test declared inside a heredoc string still gets a run link. |
| Blade | A view's variables get their types from the project code that renders it with a literal view name: `view()`, `View::make()`, `->view()`, and `Route::view()` with a data array, `compact()`, or `->with()`, and a Livewire component's, Filament page's, or class component's public properties. Views in `resources/views` that render it pass their data too: `@include`, `@includeIf`, `@includeWhen`, `@includeUnless`, and `@includeFirst` pass their data array and their own variables, typed as they are at the include; `@each` passes the item and `$key`; and an anonymous component's tags, such as `<x-card :post="$post" title="Hi" />`, pass its `@props`, with a prop's default where a tag leaves it out. This includes components that the app or a package registers, such as with `Blade::anonymousComponentPath()`, and `<x-dynamic-component>` with a literal `component` name. A component's `@aware` variables get the type that its tag passes, or else, in a component's own view, that every tag of the component passes, or that the anonymous component tag around it passes. A tag with no component tag around it in its view is inside what that view is included in: the component tags around each `@include` of the view, through the views that include those, and its default where the project's code renders a view in that chain. In a view included from a component's own view, it gets the type that component's data gives it, as Laravel looks there first: each tag's attributes for an anonymous component, and a class component's public properties and methods, or the default where the view is also rendered without a component. When that data leaves the variable out, or the component is rendered through `<x-dynamic-component>` or by another view, the variable stays untyped. A class component's view outside `resources/views/components` counts as a page, so a view it includes gets the default there. A view that includes itself is typed from what the other places pass and what it passes itself. A variable gets no type, and isn't checked, when any of those places doesn't pass it or passes a value of unknown type, when a view includes itself through other views, when a view also renders it with `@extends` or `@component`, and when the view is only rendered elsewhere, such as through `<x-dynamic-component>` with a name that isn't literal, a Mailable's `Content`, a view composer, `View::share()`, or a Livewire component without `render()`. A class component's `$except` list is read from its default value and from its constructor: lists of names, `array_merge()` of them and `$this->except`, and `$this->except[] = 'name'`. When the constructor changes it another way, or only under a condition, or another method changes it, the component's properties and methods get no type. A prop that a tag passes only through `{{ $attributes }}` isn't typed. A dynamic component whose name isn't literal isn't read, so a view it also renders can still be typed from its other tags. Laravel's conditionals narrow types, but "possibly null" problems aren't reported inside `@switch`, whose cases Mago narrows only in part, inside directives Tusk doesn't know, such as a `Blade::if()` condition, or where a view's blocks don't nest: from a block left open to the end of the block around it, and from the start of the block around an `@end…` that ends nothing to that `@end…`. Inside `@auth`, any variable that may hold an `Authenticatable` counts as the logged-in user, so a possibly null `$author` of your user model isn't reported there. Other "possibly" problems, such as on a union of the types two places pass, aren't reported in views. The Problems panel's scan covers views in `resources/views` only. Directives inside `<style>` aren't highlighted, since CSS has at-rules of its own. |
| Filament icons and colors | Unknown icons and colors are underlined only when the app boots. A color that a package registers in a `Filament::serving()` callback isn't seen, and a `->color()` call on a receiver the analyzer can't type is never checked. Changes to a project's own icon folder are read when `config/` or `composer.lock` changes, not when an SVG is added (`framework/icons.rs`). `<x-` lists every icon after the components. |
| Indexing | The PHP server indexes the project and `vendor` each time it starts, in about a second for a Laravel and Filament app with 23,000 PHP files the first time. Later starts take about 0.23 s: the server caches what each `vendor` file declares and which files each folder holds, so it reads only the folders and parses only the files that changed. Loading the classes the project reaches and resolving their inheritance still happen at each start, and take most of that. The folder cache relies on a folder's modification time changing when a file is added to it or removed from it. On a drive whose file system doesn't do that, such as FAT, a file added while Tusk was closed isn't indexed until a reindex or until you open it. It loads `vendor`'s classes only as far as the project reaches them (about one in eight on that app), in about 370 MB of memory; every class's name is still known, so completion, imports, and Go to Symbol find them all. Hidden folders, `node_modules`, `storage`, `bootstrap/cache`, and the project's index exclusions are skipped. |
| Filament designer | Works with Filament 4 and later. The canvas draws components as Filament does, close enough to judge a layout, but it isn't Filament rendering the page; **Open in the browser** shows the real one. Closures show as code, and conditions only as the designer writes them (`$get('field')` compared with values). The palette and settings come from the project's Filament and plugins, read with the app's PHP; a project whose app doesn't boot shows no panels. Relation managers find their model through the resource that registers them. Panel settings read the calls on `$panel` in `panel()`, not ones inside `if` blocks or other methods. Tenancy's setup writes the user model's side; each resource's model still needs its relationship to the tenant, which the settings list. Widget values the designer reads are the ones it writes (a model's `query()`, `where` conditions, and one count or aggregate); anything else shows as code. |
| Notifications designer | Reads and writes the bell notification as Filament's `Notification::make()` chain in `toDatabase()`, and the email as a `MailMessage` chain in `toMail()`; a Mailable, a Markdown view, or a `toArray()` with plain arrays shows as code. Broadcast and other channels show as they are, without settings. Texts with the record's fields are strings or `__()` with replacements; other code, such as a concatenation, shows as code. The designer doesn't list where a notification is sent from. |
| Navigation designer | It shows every item whatever its access rules, as if everyone could open everything. A panel that builds its navigation with `navigation(fn …)` shows as Filament would build it without that, and can't be changed. Reordering numbers the group's project items 1, 2, 3, and an item whose sort code decides keeps its place even when that breaks the new order. Group icons and collapsing are in the panel settings. A resource's record sub-navigation isn't shown. |
| Record history | The History section reads the `getActivitylogOptions()` calls it writes; other options, such as `$recordEvents` or `dontLogIfAttributesChangedOnly()`, show as code. A description is read when it's a string with `{$eventName}` in it, not other code. The History relation manager names the causer by its `name` attribute. |
| Generated tests | Fields are tested when they're always on the form: a field that a condition shows, hides, or disables, or that's in a repeater or a layout with its own relationship, is left out. File uploads, repeaters, and multiple selects aren't filled; a required one gets a comment in the create and edit tests asking you to fill it. Dates and rich text are filled but not compared after saving. A factory is found where Laravel looks for it in an app in the `App` namespace. |
| Model designer | Indexes over several columns and foreign keys to other columns than `id` show as they are but can't be edited. Renaming or changing a column needs a database that supports it (SQLite 3.25 and later, MySQL, PostgreSQL). A model whose table can't be read shows the columns its fillable attributes and casts name. |
| Environment settings | The settings edit the project's `.env`, not `.env.testing` or other environments' files. Mail service keys come from the service's entry in `config/services.php`, read as text, so keys built in code aren't shown. Values that differ from what the app uses are compared after `${VAR}` references are filled in, but not with a config file's own changes, such as a cast. |
| Automations | Conditions are all joined with **and**; a rule with **or** shows as code. The designer reads and writes one observer per model: the one named for it, or else the first the app registers; others are listed with a link. A rule written in another shape, such as an `if` with an `else`, shows as code. Setting a field isn't offered for deleted records, since they aren't saved again. |
| Scheduled tasks | The designer reads tasks in `routes/console.php`, in `bootstrap/app.php`'s `withSchedule()` closure, and in `app/Console/Kernel.php`'s `schedule()`, not tasks added inside `if` blocks or by packages. Next runs come from the cron expression, so a task with `when()`, `skip()`, or `between()` may skip some of them, and `lastDayOfMonth()` or seconds-based frequencies show none. A notification task sends a notification that takes no record. Old records are deleted with `model:prune`; marking them as archived instead is code you write (`src/schedulegen.ts`). |
| New projects | The first Filament user is created only on SQLite, since other databases need their server first; `php artisan make:filament-user` creates it later. Front-end packages need npm, pnpm, Bun, or Yarn on your PATH. |
| Mago analysis | The PHP server runs Mago's analyzer and linter in its own process, pinned to Mago 1.50.0, so a newer Mago's rules and fixes arrive only with an app update. It reads the `mago.toml` options it uses (the analyzer's switches, excludes, and ignored codes, and the linter's integrations and rules) and ignores the rest. **Settings > PHP Analysis** doesn't edit the linter's integrations, a rule's own options, or ignores limited to some paths; edit those in `mago.toml`. Once a project has its own `mago.toml`, Mago no longer gets Tusk's corrected copies of Laravel's vendor files. |
| PHPStan | It checks a PHP file as it opens and each time you save it (about 2 seconds with Larastan), so its problems describe the saved text and keep their lines until the next save. **Run PHPStan on Project** replaces the problems it found before; a Mago scan doesn't include PHPStan's. |
| Unsaved files | The Tailwind server accepts only whole-file syncs, so it gets the full text after every 150 ms pause in typing (`track` in `src/lsp.ts`). The PHP server gets each edit as you type. |
| Laravel | In Pest tests, setting a property the test case doesn't declare isn't checked. PHPStan doesn't know which test case runs a test, so on lines that use `$this`, its problems about PHPUnit's `TestCase`, Pest's `TestCall`, or `mixed` values are hidden; Mago still checks those lines. Vite assets complete from `resources/` only, though any existing file in the project checks as found. |
| Filament | The PHP server knows Filament's field names, relationships, options, and resource structure. It doesn't check column names (virtual attributes make that unreliable). `$get()` and `$set()` know the fields of schemas written in the same file; a schema that spreads in fields from elsewhere (`...self::fields()`), or a component a method returns, completes only what the file shows, and isn't checked. A read of a missing field is reported only where the file shows every key the state can hold. That excludes an action whose class fills its form, such as `EditAction`, or that fills it with code (`fillForm(fn ($record) => …)`, `mountUsing()`); a Livewire form without a literal `->statePath()`, whose fields are properties of the component, or whose class fills it with anything but literal arrays, writes the state property, has an attribute such as `#[Url]` on it, extends or uses a class of the app's own, or has a view Tusk can't find or that may write keys it doesn't name, such as `wire:model="data"`, a path built in PHP or JavaScript, or PHP that writes `$this->data`; and a relationship repeater or layout whose query or data a closure changes, that isn't at the top of a resource's form, or whose related columns come from the model's code because the database couldn't be read. Keys a view binds by name, such as `wire:model="data.extra"` or `$wire.set('data.extra', …)`, count as fields. Filament 3's and later's `Action`, `CreateAction`, and `BulkAction`, in tables, forms, and infolists too, are checked; `EditAction`, `ViewAction`, and `ReplicateAction` fill from the record. Absolute paths resolve on resource forms (`data`) and Livewire forms; in an action's modal they aren't resolved, since its state is at `mountedActions.0.data` with an index that depends on nesting. Options from a query are read with the app's PHP on a thread of their own, so they appear a moment after the file opens and are read again after a minute; a query is read only when it's a model's `pluck()` after literal `where`s, orders, limits, and scopes, and at most 100 options are suggested. Compared values are offered right after `=== `, in a `match` arm, and in `in_array()` before anything is typed, when you open the suggestions with ⌃Space. `->default(` on a `->relationship()` field suggests its records in a resource's form, a relation manager's, and a Livewire form that names its model with `->model(Post::class)`. |
| Database | A connection shared in `tusk.json` has no password on a teammate's Mac until they type theirs in Data Sources. Only SQLite, MySQL, MariaDB, PostgreSQL, and Redis connections work. Redis keys whose names aren't UTF-8 text aren't listed (the tree counts them), and elements that aren't text are read-only. Redis Cluster isn't supported: a key on another node fails with a MOVED error, which names the node to connect to. Keys group by `:` only. Module types other than RedisJSON, such as a time series, are read in the console. Read-only mode doesn't apply to Redis, and a Redis command can't be canceled; the Redis command timeout ends it. SSH tunnels need key or agent authentication, and `verify-full` fails through a tunnel, since the host is then `127.0.0.1`. Statements split at every semicolon outside strings and comments, so a trigger's `BEGIN … END` body runs only when you select the whole trigger. Each page runs the query again. Export reads every row into memory first. Binary values over 64 KB show only their size. |
| Pull requests | Comments on lines outside the diff's changes are rejected by GitHub. Pending comments saved on this Mac by an earlier build aren't moved to GitHub. Resolve state loads for the first 100 threads. You can't edit a review's summary. |
| HTTP client | GraphQL highlighting shows in the Query editor only, not in `.http` files. gRPC calls ignore `# @insecure`, proxies, and client certificates, don't stress test or copy as code, and a client streaming call sends all of its messages at once. The history keeps the last 100 unpinned requests per project, without secrets, so a request from an earlier session is sent again from its file. Hiding secrets in response bodies goes by field name in JSON and form bodies only, so a token in HTML, XML, or a field with another name stays. Stress tests and monitoring run no scripts. Request bodies from validation rules come from regexes over the PHP (`validationRules` in `src/phptypes.ts`), so rules built in loops or from other methods are missed. Herd and Valet detection (`appAddresses` in `src/laraveltools.ts`) reads Valet's config layout. |
| Project settings | Sessions (open tabs and terminals), HTTP client history and cookies, and which vendor folders the index scan already offered are still kept in the web view's storage, so a reset of the web view loses them. `tusk.json` is written as plain JSON, so comments in it make it invalid, and spacing inside a value you edited by hand isn't kept when Tusk changes the file. |
| Split editors | Up to four panes. |
| Deployment | Uploads, downloads, and comparisons go file by file over SFTP, FTP, or FTPS; there's no WebDAV and no rsync. SFTP reads `~/.ssh/config`, but not certificate logins, `Match exec` (whose command Tusk doesn't run), `Match` criteria that need the network, such as `address`, or `CanonicalizeHostname`'s lookups. A `ProxyCommand` runs with `sh` (on Windows, the one Git for Windows has). Of a server's `ProxyJump` hosts, only the first can have a `ProxyCommand` of its own, and a jump host's own `ProxyJump` isn't followed. A jump host's password or key passphrase is asked for and saved per user and host; one that asks for more than a password, such as a one-time code, can't log in. A replaced file on the server keeps its permissions, and on SFTP its group, and its owner where the server lets you change it (as root); on FTP, permissions carry over only where the server allows `SITE CHMOD`. Deleting files on the server as you delete them in the project covers the default server, while saved files upload to it. Files deleted while Tusk was closed are found only among those Tusk uploaded, downloaded, or found the same on both sides in Sync with Deployed, so a file another tool put on the server isn't; that record is kept on this computer, not shared. Sync with Deployed compares by size and modification time, and reads both copies only for files of the same size whose times differ (up to 4 MB each). Server files opened from Remote Host check for changes on the server when Tusk gets focus and every 30 seconds, by size and time. |
| Keymap | Two-key chords, such as ⌘K ⌘X for **Trim Trailing Whitespace**, are Monaco's own and can't be changed or shown in the menu bar. Giving a Monaco command, **Send HTTP Request**, or **Execute Query** another shortcut adds it; Monaco's default key keeps working. |
| Super methods | The gutter arrows show what the index knows, so right after an edit they can lag until the server has indexed it. A class shows no arrow for its own parent or interfaces; ⌘U goes there. |
| Terminal | A shell whose profile changes `PATH`, such as with mise or Herd, can put another `php` first in shell tabs; command tabs use the paths from **Settings > Tools**. |
| Tool paths | A shared `phpInterpreter` is a path, so it works on Macs that install PHP in the same place. Language servers keep the PHP and Node.js they started with until you restart them. |
| Settings designer | Renaming a property renames it in the class and the stored values, but not in code that reads it, such as a settings page's field. Dates are written as `CarbonImmutable` and rely on the package's global cast for dates. An encrypted property shows its encrypted value, and the designer writes `add` rather than `addEncrypted` for new ones. A settings migration that hasn't run yet isn't seen, so run pending migrations before applying. |
| Platform | AI completion on Intel Macs runs on the CPU, since llama.cpp's Intel build has no Metal support. Windows and Linux are newer and less tested than macOS. There, Ctrl does what ⌘ does in the shortcuts, so a shortcut that uses ⌃ on a Mac needs the Windows key, and in Vim mode a Ctrl key that is also a Tusk shortcut, such as Ctrl+D, runs the shortcut instead of Vim's command. On Windows, the app's shell commands, such as installing packages or Git with a password prompt, run in Git for Windows' `sh`. AI completion there uses the GPU through Vulkan, or the CPU. Windows on ARM isn't supported. |

### Missing

| Area | Gap |
| --- | --- |
| Debugger | With Sail, `sail debug` uses Sail's own Xdebug settings, so a port other than 9003 needs `SAIL_XDEBUG_CONFIG="client_host=host.docker.internal client_port=<port>"` in `.env`. A request to Xdebug that never answers, such as while PHP is stopped in another debugger, leaves the tab running until you stop it. Values in the editor come from the lines' `$names`, so a name from another scope, such as a closure's, can show the outer value. Xdebug can't tell at a throw whether code will catch the exception, so **Only uncaught** pauses later: in Laravel, when its handler starts rendering the exception, and elsewhere, at PHP's fatal error, when the stack is gone and chosen classes match by name only, without their subclasses. A queued job's exception isn't rendered, so it doesn't pause. |
| Local history | Reverting to a label doesn't delete files created after it. Versions from before this release show as **Saved**. A closed file's text before its first change by another program is kept only if git has it staged. One burst of changes by other programs keeps at most 200 closed files, so a branch switch that rewrites more keeps only some. Deleting a folder keeps its first 500 files, leaving out ignored ones such as `vendor`. |
| Refactoring | Rename, the Extracts, Introduce Field and Parameter, Inline, and Move Class come from the PHP server. Move Class needs a PSR-4 map in `composer.json` that covers the new folder. Extract Method refuses a selection with a `return` that doesn't end its function, and doesn't check `break` or `continue` for a loop outside the selection. Extract Variable and Introduce Field assign the value before the statement that held it, as PhpStorm does, so an expression that ran only sometimes, such as in a `match` arm or on the right of `&&` or `??`, then runs every time, and one in a loop's condition runs once. The occurrences popup and the hint above the new name warn when that happens. Introduce Field initializes the property in the current method only, not in the constructor or its declaration. Extract Constant writes a class constant, not a global `const`. Change Signature finds overriding methods only in project files, not `vendor`, and a constructor's calls only where the class is named, so `new $class()` and the service container's `app(Money::class)` aren't changed. It leaves the method its method overrides, such as an interface's, as it is, and lists it in the preview with the calls it couldn't change: a call that spreads its arguments (`...$args`), or that has a comment on a line of its own between its arguments. Change Signature, Inline, and Safe Delete don't see uses through dynamic names, such as `$this->$method()` or `constant('Order::LIMIT')`. Inline Variable needs a variable assigned once, by a statement of its own, in the block that holds its uses. Inline Method needs a body with at most one `return`, at its end, and keeps the method when any call can't be inlined. A trait's method called on another object needs the analyzer to know the object's class; a call on a value that can be one of several classes that each use the trait is skipped. A call whose value is used, of a method with statements, is inlined only where its statement runs it every time and first: not on the right of `&&` or `??`, in a loop's condition or an `elseif`, or after another call in the statement. Pull Members Up offers parents and interfaces in the project, not in `vendor`, and checks sibling classes found by a text search for the parent's name. Extract Interface changes parameter and private property types, not return types or public and protected properties, and reads a parameter's uses within its function only; it doesn't follow a value passed on. Moved code's unqualified constants are recognized by upper-case names. |
| Tools | Spell checking flags known misspellings, not every word missing from a dictionary, so rare typos can slip through. There's no comment that turns spelling off for one line: typos-lsp lets the project's ignore patterns replace a user-wide one. AI completion reads the classes PHP and Blade files use, and the project files JavaScript, TypeScript, and Vue files import, but not the types of packages in `node_modules`. It indexes at most 3,000 files. |
| Coverage | Which tests ran a line comes from PHPUnit's XML coverage, which only records lines of the folders in `phpunit.xml`'s `<source>`. |
| Profiler | Requests you make in a browser are named by URL from the profile's file name, where Xdebug turns `/`, `.`, `?`, and `&` into `_`, so a query string reads as more path. The table shows up to 500 functions at a time; filter to find the rest. Profiling runs on this Mac, not in Sail. |
| Code signing | The app is ad-hoc signed, not notarized, so on another Mac, Gatekeeper blocks the first install until you allow it in **System Settings > Privacy & Security**. Notarizing needs a paid Apple Developer account. |

## Requirements

To use the app, you need:

- macOS, Windows 10 or later on x64, or Linux on x64 or ARM64 with WebKitGTK 4.1
- PHP 8.1 or later. The app finds PHP through your login shell's `PATH` (on
  Windows, the system's), so installs from Homebrew, Laravel Herd, or your
  package manager work, or you set its path in **Settings > Tools**.
- Git, and optionally the GitHub CLI (`gh`) for pull requests. On Windows,
  install Git for Windows: the app runs its shell commands with its `sh`.
- Node.js, for Tailwind CSS, JavaScript, TypeScript, and Vue support. Laravel
  projects that use Vite already need it.

To build the app, you also need:

- Rust 1.97 or later
- Node.js 24 or later, and pnpm

The app manages its own tools (Mago, Composer, `typos-lsp`,
the Xdebug adapter, `llama-server` for AI completion, and the Tailwind CSS, TypeScript, and Vue language
servers), and compiles in the database drivers, so you don't install them
yourself. The first launch downloads the tools for your system and chip (about
90 MB) into `~/Library/Application Support/ly.almontasser.tusk/tools/` on a Mac,
`%LOCALAPPDATA%\ly.almontasser.tusk\tools\` on Windows, or
`~/.local/share/ly.almontasser.tusk/tools/` on Linux, and
checks for newer versions at launch and every six hours, unless you turn off
**Check for app and tool updates automatically** in **Settings > Tools**. Sail support needs
Docker, which Sail itself needs. The PHP language server is the app's own
binary, started with `lsp`, so there's nothing to download for it. It runs
Laravel's and Filament's PHP scripts with the project's PHP: Herd's or Valet's
PHP for the site, Sail's, Lando's, or DDEV's container, else the PHP from
**Settings > Tools**. A language server that crashes restarts on its own; if it keeps
crashing, the status bar asks you to reopen the project.

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

## The window

- **Title bar:** the project name (click it for a dropdown to switch to a
  recent project or open a folder), the current branch and its pull request, a **Search everywhere**
  box, and buttons for the debug server, the terminal, and settings.
- **Tool bar on the left:** icons for the **Project**, **Commit**, **Pull
  Requests**, and **Find** views. Click the active icon to hide the sidebar,
  and drag the sidebar's edge to resize it. The icons at the bottom open the
  **Git Log**, the **Debug** panel, and the terminal.
- **Bottom panel:** the terminals and tool windows such as **Problems**, **Git
  Log**, **Debug**, and **Tests**. Drag its top edge to resize it. The buttons
  at the right of its tab bar maximize it (⇧⌘'), open its options, and hide it
  (⇧⎋ while you work in it). In the options, or in **View > Toggle Full-Width
  Bottom Panel**, choose whether the panel sits under the editor, beside the
  sidebar, or spans the full window width under both, as in PhpStorm.
  Maximized, the panel fills the editor area, or with the full-width layout,
  the whole window below the title bar. Hiding the panel restores its size and
  puts focus back in the editor.
- **Splits:** drag the edge between two parts to resize them: the sidebar, the
  bottom panel, and the parts of the **Debug**, **Tests**, **Git Log**, and
  **Profiler** tabs. Each handle takes focus with Tab; then the arrow keys move
  it (with Shift, in bigger steps), and Home and End go to the limits.
  Double-click a handle, or press Enter on it, to go back to the default size.
  Each window remembers its sizes and the panel's layout.
- **Status bar:** error and warning counts for open files (click them to list
  the problems), the file's path followed by breadcrumbs for the class and
  method at the cursor (click one to go to it), background work such as
  indexing, the cursor position,
  indentation, line endings, and the file's language.
- **Welcome screen:** without an open folder, the window lists your recent
  projects. Tab and Enter open one; right-click one to remove it from the list.

Errors, such as a failed git command, also appear briefly in the lower-right
corner. Any failure the app doesn't otherwise handle shows there too, once
while its message is on screen, so nothing fails silently. Long tasks, such as
merging a pull request or counting Redis keys, show a spinner in the status
bar, and a **Cancel** button when you can stop them.

## Keyboard shortcuts

Shortcuts follow PhpStorm's macOS keymap. To see every action and its
shortcut, press ⌘⇧A (**Find Action**).

The menu bar (File, Edit, View, Navigate, Code, Refactor, Run, Tools, Git,
Window, and Help) runs the same actions and shows each one's current shortcut,
except double taps such as ⇧⇧ and two-key chords such as ⌘K ⌘X. An editor-only
shortcut, such as ⌘D for **Duplicate Line**, still reaches text fields and the
terminal when the editor doesn't have focus. On Windows and Linux, the menus
show ⌘ as Ctrl and ⌃ as the Windows key. To search the menus on a Mac, use the
search field in Help. **Help > Keyboard Shortcuts** lists every action that has
a shortcut; pick one to run it.

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
| ⌥⌘O | Go to symbol in the project: classes, functions, constants, and methods (`User::save` narrows to a class's) |
| ⌘E | Recent files |
| ⌘⇧F | Find in files |
| ⌘⌥↓, ⌘⌥↑ | Next and previous match in the Find view's results, while it shows |
| ⌘⇧R | Replace in files |
| ⌃H | Type hierarchy of the type under the cursor, or the one the cursor is in |
| ⌃⌥H | Call hierarchy of the method or function under the cursor, or the one the cursor is in |
| ⌃T | Refactor This: the refactorings for the caret or selection |
| ⌘⌦ | Safe delete the class, method, or function at the cursor |
| ⌥⌘V | Extract the expression at the cursor, or the selection, into a variable |
| ⌥⌘C | Extract the string or number at the cursor into a class constant |
| ⌥⌘M | Extract the selection into a method |
| ⌥⌘F | Introduce a field (property) for the expression at the cursor |
| ⌥⌘P | Introduce a parameter for the expression at the cursor |
| ⌥⌘N | Inline the method, class constant, or variable at the cursor |
| F6 | Move the file's class to another namespace |
| ⌘F6 | Change the signature of the method or function at the cursor |
| ⌘⇧F10 | Open the query console |
| ⌘⏎ | Run the SQL statement under the caret, or send the HTTP request under the caret in an `.http` file |
| ⌥⇧⌘C | Copy a reference to the caret's line, such as `app/Models/User.php:42` |
| ⌃⌥⇧↓ and ⌃⌥⇧↑ | Next and previous change |
| ⌘F12 | File structure |
| F3 | Toggle a bookmark on the current line |
| ⌥F3 | Toggle a bookmark with a mnemonic (a digit or letter) |
| ⌘F3 | Show the Bookmarks tab |
| ⌃1 … ⌃9 | Go to the bookmark with that digit |
| ⌘B or ⌘-click | Go to declaration |
| ⌥⌘B | Go to implementation |
| ⌃⇧B | Go to type declaration |
| ⌘U | Go to super method: what the method at or around the caret overrides or implements, or the class's parent class and interfaces |
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
| ⇧⌘' | Maximize the bottom panel, or restore it |
| ⇧⎋ | Hide the bottom panel, while you work in it |
| ⌘F in a terminal | Find in the terminal's output |
| ⌃⌃ | Run anything: Artisan commands or shell commands |
| ⌃⇧R | Run the test at the cursor, or all tests in the file |
| ⌃R | Run the selected run configuration |
| ⌃D | Debug the selected run configuration |
| ⌃⌥R, ⌃⌥D | Choose a run configuration to run or debug |
| ⌘F2 | Stop the running configuration (while one runs; otherwise, stop debugging) |
| ⌃⇧D | Debug the test at the cursor |
| ⌘F8 | Toggle a breakpoint on the current line |
| ⇧⌘F8 | View breakpoints, with the current line's breakpoint selected to edit its condition, hit count, or log message |
| F9 | Resume (while debugging) |
| F8, F7, ⇧F8 | Step over, step into, step out (when not paused, F8 and ⇧F8 go to the next and previous problem across files) |
| ⌘K | Commit |
| ⌘⇧K | Push |
| ⌘T | Update the project (pull, merging or rebasing) |
| ⌘1 | Show the project tree |
| ⌥F1 | Select the current file in the project tree (also the target button above the tree) |
| ⌘\ | Split the editor to the right, or move to the next pane |
| ⌘⇧\ | Split the editor down |
| ⌘9 | Git log |
| ⌘S | Save all files |
| ⌘Q | Quit; unsaved changes are saved (with auto-save) or asked about first, as when closing the window |
| ⌘, | Settings |
| ⌘W | Close the tab |
| ⌃\` | Color theme |
| ⌃Space | Show completions |
| ⌘F, ⌘R | Find or replace in the file |
| ⌘G, ⌘⇧G | Next and previous match |
| ⌘L | Go to line and column |
| ⌃M | Go to the matching bracket |
| ⌘/ | Comment or uncomment lines with line comments |
| ⌥⌘/ | Comment or uncomment with a block comment |
| ⌃G | Add the next occurrence of the selection to the selection |
| ⌃⌘G | Select all occurrences |
| ⌥⌘↑ and ⌥⌘↓ | Add a caret above or below |
| ⌥⇧G | Add carets to the ends of the selected lines |
| ⌃⇧J | Join lines |
| ⌘⇧U | Toggle case |
| ⌃⌥I | Auto-indent lines |
| ⌘= and ⌘- | Expand or collapse the fold at the caret (with ⌥, recursively; with ⇧, all) |

Monaco's other editing commands, such as sorting lines, changing case, and
folding by level, are in the Edit and Code menus and in Find Action, with
Monaco's own shortcuts where it has them (such as ⌘K ⌘X to trim trailing
whitespace). The keymap editor can give them other shortcuts; a two-key chord
such as ⌘K ⌘X stays Monaco's and can't be changed there.

To open a folder, click **Open Folder…** in the sidebar or run the **Open
Folder…** action.

## Settings

Press ⌘, to open **Settings**. Settings are grouped under Appearance, Editor,
Terminal, Tools, Git, Debugger, Database, HTTP Client, Spelling, PHPStan, PHP
Analysis, AI, Project Tree, Local History, and Limits; PHPStan and PHP Analysis
apply to the open project. A setting that depends on another, such as the AI model,
shows only when it applies. Changes apply immediately and are saved in
`~/Library/Application Support/ly.almontasser.tusk/settings.json`.

- Type in the search box to filter settings in every group by name,
  description, or key. Escape clears the search.
- A setting you changed has a reset button beside it. **Reset All…** resets
  every setting in the dialog after you confirm; your keymap and project
  settings stay.
- Groups marked **This project** apply to the open project only, and show
  only while one is open. Their **Share in tusk.json** box keeps them in the
  project's `tusk.json` so your team gets them; otherwise they stay on this
  Mac (see "Project settings and tusk.json").
- **Open settings.json** opens the file in the editor. When you save it there,
  Tusk applies it.
- A number outside its range isn't applied; the dialog says which numbers it
  takes.
- If `settings.json` isn't valid JSON, Tusk uses the defaults, doesn't write the
  file until you fix it, and offers to open it. A value of the wrong type, or a
  number out of range, uses its default and stays in the file until you change
  that setting. Keys Tusk doesn't know stay in the file.

| Setting | Default |
| --- | --- |
| Theme: one of about 110 color themes, or match the system | Dark |
| Themes in dark and light mode, for Match the system | Dark, Light |
| Editor font and font size | JetBrains Mono (or its Nerd Font build), or else Menlo, at 13; ligatures are on only with a font that has them |
| Wrap long lines | Off |
| Show the minimap | Off |
| Show inlay hints | On |
| Show the cursor line's problem at the end of the line | Off |
| Vim emulation | Off |
| Save files automatically | On |
| Format files when saving | Off |
| Check spelling | On |
| Spelling: show misspellings as | Typos (a green wavy underline) |
| Spelling: file types to check | All: PHP, Blade, JavaScript, TypeScript, Vue, Svelte, Astro, Markdown, HTML, CSS, SCSS, JSON, YAML, plain text |
| AI code completion, and its model | Off, Qwen2.5-Coder 3B |
| Terminal font and font size | Same as the editor's |
| Terminal shell and its arguments | Your login shell (`$SHELL`), `-l`; PowerShell, `-NoLogo` on Windows |
| Tools: paths of PHP, Composer, Node.js, Git, the GitHub CLI, and Docker | Empty: found on your `PATH`; Composer is the bundled `composer.phar` |
| Tools: check for app and tool updates automatically | On |
| Project tree: show hidden files and folders | Off |
| Limits: recent projects to remember | 12 |
| Limits: most matches for Find in Files and TODO | 20,000 |
| Limits: HTTP requests to keep in the history, and the largest response to show | 100, 5 MB |
| Local history: days and versions to keep, and the largest file | 14 days, 100 versions, 1,000 KB |
| Debugger: Xdebug port | 9003 |
| Debugger: items to load per array or object, and the longest string to load | 128, 2048 bytes |
| Debugger: pause at the first line of each script | Off |
| Debugger: show variable values in the editor while paused | On |
| Debugger: IDE key (`XDEBUG_SESSION`) and the host PHP in Docker connects to | `1`, `host.docker.internal` |
| Git: how Update Project brings in commits (merge, rebase, or git's `pull.rebase`) | Merge |
| Git: group changed files by folder in the Commit view | Off |
| Database: rows per page, connection timeout, query timeout, and Redis command timeout | 1,000 rows, 10 s, none, 60 s |
| HTTP Client: response bodies in the history | Keep, with secrets hidden |

### Tools

**Settings > Tools** sets the programs Tusk runs: PHP, Composer, Node.js, Git,
the GitHub CLI (`gh`), and Docker. Leave a path empty to use the one on your
login shell's `PATH`.

- Each path has **Browse…** and **Test**. Under it, Tusk shows what it finds,
  such as "Detected: /opt/homebrew/bin/php (PHP 8.4.2)", or the version of
  the path you set, or why it can't run.
- The PHP box offers the interpreters on this Mac: Homebrew's versions, Herd,
  Herd Lite, MAMP, `/usr/bin/php`, and the shims and installs of asdf, phpenv,
  and mise.
- A change applies to the next command you run, without a restart. The
  language servers started with the old PHP or Node.js, so Tusk offers to
  restart them.
- When a tool is missing, Tusk says so, such as "PHP wasn't found. Install it,
  or set its path in Settings > Tools.", with **Open Settings**.
- **Check for app and tool updates automatically** checks at launch and every
  six hours. Turn it off on an offline or locked-down Mac; **Tusk > Check for
  Updates…** still checks for both.

A project can use another PHP: **Tools > Choose PHP Interpreter…** lists the
interpreters on this Mac, a file you choose, and the default from Settings. The
choice is a project setting, which you can share in `tusk.json`.

**Settings > Terminal** sets the shell for new terminal tabs and its arguments
(`-l` by default, for a login shell). On Windows, the default is PowerShell
with `-NoLogo`. When PowerShell's arguments don't run a command or script,
Tusk adds a prompt that keeps its process in the folder you `cd` to, so the
tab reopens there.

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
between two panes to resize them, or press Tab until the border has focus and
use the arrow keys (with Shift, in bigger steps). Run **Unsplit** to close the focused pane and
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

In a terminal:

- Press ⌘F to find in its output. Matches highlight as you type; ⏎ and ⇧⏎ go
  to the next and previous match, **Aa** matches case, **.\*** takes a regular
  expression, and Escape closes the bar.
- URLs are links: click one to open it in your browser.
- File references such as `app/Models/User.php:42`, `Foo.php(12)` in a PHP
  stack trace, or `on line 7` open the file at that line when you click them,
  from test failures, Mago, PHPStan, and PHP errors. Relative paths resolve
  from the terminal's folder, then the project's, and Sail and Docker paths
  under `/var/www/html` map to the project. On Windows, paths such as
  `C:\app\Models\User.php:42` are links too. Only files that exist are links.
- Shortcuts with ⌃ or ⌥ go to the shell, such as ⌃R to search its history.
  On Windows and Linux, Ctrl with a letter and no Shift goes to the shell, so
  Ctrl+W deletes a word; Ctrl+Shift shortcuts still go to Tusk.
- Double-click a terminal's tab, or right-click it and choose **Rename…**, to
  rename it. With a tab focused, ← and → move between tabs.

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
project closes the terminals of the one before. Refactorings such as rename
save every file they change.

## Project settings and tusk.json

Tusk keeps some settings per project: breakpoints, watches, and how the
debugger pauses on exceptions; the server paths for debugging; the Docker
service that runs commands; saved database connections and their SSH tunnels;
the index exclusions; run configurations; the PHP interpreter; the formatters; the hidden and excluded files; PHPStan's settings; the last URL you profiled; and the stress test form. Each
one lives in one of two places:

- **On this Mac**, in a file per project in
  `~/Library/Application Support/ly.almontasser.tusk/projects/`. It survives
  restarts and updates. This is where a setting starts.
- **Shared**, in `tusk.json` at the project's root, so your team gets the same
  settings when you commit the file.

To choose what to share, run **Tools > Share Project Settings in tusk.json…**:
it lists each setting a team may want, where it's kept now, and moves the one
you choose to `tusk.json` or back to this Mac. The places that set these
settings offer the same choice: **Share with the project in tusk.json** in
**Index Exclusions**, **Save and share in tusk.json** when you set the server
paths, and a share row in **Choose Docker Service for Commands**, **Pause on
Exceptions Options**, **Database: Switch Connection**, and **Share saved
connections in tusk.json** in **Data Sources**. Database passwords
are never shared: connection URLs leave them out, and each person's password
stays in their Keychain.

Tusk edits `tusk.json` in place: it keeps keys it doesn't know, their order,
the file's indentation, and its final newline. When you or `git pull` change
the file, Tusk reads it again; changed index exclusions reindex the project,
and changed breakpoints and exception options apply at once. If the file isn't
valid JSON, Tusk says so, keeps the values it read last, and doesn't write to
it until you fix it. The editor checks `tusk.json` against its schema
(`src/schemas/tusk.json`), with completion and descriptions for each key.

An example:

```json
{
  "indexExclude": ["vendor/aws/aws-sdk-php/src/data", "vendor/**/resources/lang"],
  "debugPathMappings": "/var/www/html",
  "debugExceptions": { "pause": true, "classes": ["App\\Exceptions\\PaymentFailed"], "uncaughtOnly": false, "skip": ["vendor/**"] },
  "dockerService": "laravel.test",
  "databaseConnections": [{ "name": "reporting", "url": "pgsql://reader@db.internal:5432/reports" }],
  "databaseSsh": { "reporting": "forge@203.0.113.5" },
  "runConfigurations": [
    { "name": "Unit tests", "type": "test", "scope": "directory", "path": "tests/Unit", "args": "--stop-on-failure" },
    { "name": "Fresh database", "type": "artisan", "command": "migrate:fresh --seed", "before": [{ "command": "npm run build" }] }
  ]
}
```

| Key | Contents |
| --- | --- |
| `indexExclude` | Folders the PHP index and Mago skip, relative to the project. `*` matches within a folder name, `**` any number of folders. |
| `debugPathMappings` | Where the project is on the server: comma-separated `/server/path` (the project folder) or `/server/path=local/path` entries. Empty when PHP runs on this Mac. |
| `debugExceptions` | `pause`, the exception `classes` to pause on (empty for all), `uncaughtOnly`, and `skip`, path patterns where a throw doesn't pause. |
| `breakpoints` | Line breakpoints by file, relative to the project: `[line, options]` pairs, where options can have `condition`, `hitCondition`, `logMessage`, and `disabled`. |
| `debugWatches` | The debugger's watch expressions. |
| `dockerService` | The Compose service that runs tests, Artisan, and Tinker; empty for this Mac. |
| `databaseConnections` | Saved connections, each a `name` and a `url` without a password. |
| `databaseSsh` | The SSH tunnel for each connection, by name; the empty name is `.env`'s connection. A destination such as `forge@203.0.113.5`, or `{ "destination": …, "identityFile": "~/.ssh/staging" }` with a key file. |
| `databaseReadOnly` | The names of connections that refuse changes; the empty name is `.env`'s connection. |
| `runConfigurations` | Shared run configurations: each a `name`, a `type` (`test`, `artisan`, `php`, `composer`, `npm`, `shell`, or `server`), and that type's fields. Configurations you don't share stay on this Mac. |
| `formatters` | The formatter (`use`) and format on save (`onSave`) for each language group: `php`, `blade`, `js`, `css`, `json`, `markdown`, and `yaml`. |
| `treeHidden`, `treeExcluded` | Patterns the project tree hides, or shows dimmed. A name matches at any depth; a path matches from the project's folder. |
| `phpInterpreter` | The PHP program this project uses instead of the one in **Settings > Tools**, such as `/opt/homebrew/opt/php@8.3/bin/php`. |
| `phpAnalysis` | The PHP index: `loadAllLibraries`, and `stubs`, comma-separated folders or files read as library code. |
| `phpstan` | PHPStan's settings: `enabled` (`auto`, `on`, `off`), `config`, `level`, `memoryLimit`, `timeout`, and `run` (`save` or `demand`). |

The selected database connection, `.env`'s override, the query history, the
last profiled URL, the stress test form, and your own, temporary, and selected
run configurations (`databaseConnection`, `databaseEnvOverride`,
`databaseHistory`, `profilerUrl`, `httpLoadTest`, `localRunConfigurations`,
`temporaryRunConfigurations`, and `selectedRunConfiguration`) are personal,
so they stay on this Mac. The first time you open a project in this version,
Tusk moves these settings out of the web view's storage, where earlier
versions kept them.

## Lists and trees

Tool window lists and trees work from the keyboard: the Problems, Search,
TODO, Coverage, Composer, and Pull Requests lists, the Database tool's tables
and Redis keys, Data Sources, and the Profiler's table. Click a list or press Tab to focus it, then:

| Key | Action |
| --- | --- |
| ↑ ↓ | Previous or next row |
| Home, End | First or last row |
| Page Up, Page Down | A page up or down |
| Enter | Open the row, or expand or collapse a folder |
| → ← | Expand or collapse a tree node; ← on a child goes to its parent |
| Letters | Jump to the next row that starts with what you type |

In a search box above a list, ↓ moves to the list.

## Context menus

Right-click the code for the actions at the caret, as in PhpStorm: context
actions, the clipboard and **Copy Reference**, **Find Usages**, the **Go To**,
**Refactor**, **Folding**, and **Git** submenus, **Generate…**, comments,
formatting, running the test (in test files), and the Markdown preview (in
Markdown files). Each shows its shortcut from your keymap. Hover over a
submenu, or press → on it, to open it. Right-click
the gutter for breakpoints, bookmarks, the line's change, and blame.

## Files

Right-click the project tree for **New File…**, **New Folder…**, **Rename…**,
**Move to Trash**, **Find in Folder…** (Find in Files limited to the folder),
**Open in Terminal**, **Copy Path**, **Copy Relative Path**, and **Reveal in
Finder**. In the tree, you can also press:

- ↑ and ↓ to move between rows, and ⏎ to open a file or folder.
- F2 or ⇧F6 to rename.
- ⌘⌫ or Delete to move to the Trash.

Drag a file or folder onto a folder to move it there.

### Hidden and excluded files

Each project has two lists of patterns, which **Tools > Hidden Files and
Folders…** edits, one pattern per line:

- **Hidden** entries don't show in the tree: `.idea`, `.phpunit.cache`, and
  `.phpunit.result.cache` by default. Right-click a file or folder and choose
  **Hide in Project Tree** to add it.
- **Excluded** entries show dimmed, as PhpStorm marks excluded folders:
  `vendor`, `node_modules`, `storage`, `.claude`, `dist`, and `build` by
  default.

A name, such as `node_modules` or `*.log`, matches at any depth; a path, such as
`public/build`, matches from the project's folder. Local history skips both
lists. The lists are project settings, which you can share in `tusk.json`. The
eye button in the tree's header, **View > Show Hidden Files**, or **Show hidden
files and folders** in Settings shows hidden entries, dimmed. The tree never
shows `.git` or `.DS_Store`.

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

To preview a Markdown file, click the preview button at the end of its pane's
tabs, choose **View > Markdown Preview**, right-click the code or the tab and
choose **Markdown Preview** or **Open Preview**, or run it from ⌘⇧A. The preview opens in the pane to the
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
  `*.php, *.blade.php` or `app/**`, and files or folders to leave out in the
  exclude field, such as `tests, *.min.js`. Files ignored by `.gitignore` are
  never searched.
- The query, include, and exclude fields remember your last 20 values, which
  they offer as you type. A value is kept when you press ⏎, open a result, or
  replace.
- Typing starts a new search and stops the one still running.
- Results are grouped by file, with each match highlighted. Click a match to
  open it. Files start expanded until about 2,000 matches show; click a file
  to expand or collapse it, or use **Expand All** and **Collapse All** in the
  view's header.
- In the results, ↑ and ↓ move, → and ← open and close a file, and Enter or F4
  shows the match in the editor. While the Find view shows, ⌘⌥↓ and ⌘⌥↑ go to
  the next and previous match from anywhere, opening each one; otherwise they
  add carets in the editor.
- **Replace All**, or ⏎ in the replace field, opens the **Replace Preview** tab:
  every match by file, each line before and after. Clear a file's or a match's
  checkbox (Space on the selected row) to leave it out, then click
  **Replace N Matches** (⌘⏎). A line that changed since the search is left
  alone, and the message says so. When the results stopped at 20,000 matches,
  **Replace in All Files…** replaces in every matching file without a preview,
  after you confirm. **Replace** on a file previews only that file, and a
  match's replace button changes only that match. In regex mode, `$1` or
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

## The Designers tool window

The **Designers** tool window (its icon is in the tool window bar) is where
the designers start:

- **App designers:** a tile for each of the app's designers, which opens it or
  asks which model, enum, or class to open. The tiles are Models, Enums,
  Access, Notifications, Automations, Schedule, Environment, App settings,
  Record history, and Check the app. Click the heading to hide them.
- **Panels:** each Filament panel, with chips for its **Dashboard**,
  **Navigation**, and **Settings**, then its resources and pages as the
  panel's navigation lists them.

## Filament designer

The designer builds a Filament resource without writing code: its form, table,
infolist, relation managers, pages, and settings. It works with Filament 4 and
later. To open it, do one of the following:

- Open the **Designers** tool window and click a resource. It lists each panel's
  resources by navigation group.
- Click **Open in Designer** above a resource's or relation manager's class, or
  above a Filament 4 schema class such as `PostForm`.
- Run **Filament: Open Resource in Designer…** from the palette.

The designer edits the resource's code, and the code is all it keeps. Each
change is a small edit that's saved at once, with local history, and comments,
closures, and code it doesn't read stay as written. Code it can't show as a
component shows as a **Code** block, which you can still move or delete.
Changes you make in the code editor show in the designer as you type.

### Forms, tables, and infolists

The canvas draws the form, table, or infolist as Filament does: sections,
grids with column spans, tabs, wizards, repeaters, and every field type.

- **Add a component:** drag it from the palette on the left, or click it to add
  it after the selected component. Fields, columns, and filters ask for a name,
  and suggest the model's columns that aren't used yet.
- **Add a model column:** drag it from the model's column list to get the
  component that suits it, already set up. For example, a foreign key becomes a
  searchable relationship select, and a boolean becomes a toggle.
  **Add N** adds every column that's missing.
- **Change a component:** select it and use the inspector on the right. The
  settings people change most come first, then every other setting the class
  has, grouped and searchable. Options come from a list, an enum, or a
  relationship. **Visible when**, **Required when**, and **Disabled when** build
  conditions on other fields, and mark those fields `live()`.
- **Rearrange:** drag components, or use <kbd>⌥↑</kbd> and <kbd>⌥↓</kbd>.
  Right-click a component to duplicate it, wrap it in a section or grid, or show
  it in the code.
- **Tables:** columns sit in the table's header, and filters, row actions, bulk
  actions, and header actions sit in lanes below it. With nothing selected, the
  inspector shows the table's own settings, such as the default sort.

| Key | Action |
| --- | --- |
| <kbd>⌫</kbd> | Delete the selected component |
| <kbd>⌘D</kbd> | Duplicate it |
| <kbd>⌥↑</kbd> / <kbd>⌥↓</kbd> | Move it up or down |
| Arrow keys | Select the previous, next, parent, or first child component |
| <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> | Undo or redo the designer's last change |
| <kbd>Esc</kbd> | Select the parent |

Values the designer can't show in full, such as closures, options with keys
written as code, or settings a method decides, show as code you can open. The
designer asks before replacing them. A file with syntax errors opens read-only
until you fix them. When the app can't start, the Designers tool window shows
why, with a link to the file and line, and still lists the resource files.

The palette lists the components the project has: Filament's, plugins', and the
project's own. Each setting's editor comes from its parameter types, so a new
Filament version or a plugin needs no update to Tusk.

### Actions and their forms

- **Page actions:** the **Page actions** tab shows the header actions of the
  resource's list, create, edit, and view pages: the buttons beside the page's
  title. Pick a page at the top, then add, arrange, and set up its actions as
  in a table's lanes. A page without header actions gets them with one click,
  starting with the ones that page usually has.
- **Forms:** select an action, in a table or on a page, and its modal shows
  below: the heading, the description, the form, and the buttons. Drag fields
  or model columns into it, or click them in the palette, as in a form.
- **What it does:** a custom action can save its form to the record, set a
  column to a value (an enum column offers its cases), delete the record, or,
  on a list page, create a record. It can also send one of the app's
  notifications about the record, to the people you pick (see
  [Notifications designer](#notifications-designer)). It can then show a
  success notification.
  Bulk actions do the same to each selected record. Saving the form also fills
  it with the record's values when it opens. The designer writes these as the
  action's code; an action written otherwise shows as code.

### Access

The **Access** tab decides who can do what with the resource's records, from
the model's policy. Each ability (see the list, view, create, edit, delete, and
under **More abilities** the bulk and soft-delete ones) is **Everyone**,
**Nobody**, or **Only users who…** have a permission, have a role, or own the
record, by a column such as `user_id`. Join conditions with **or** or **and**.
Filament hides what someone can't do. An ability the policy doesn't have is
allowed. A rule written as other code, such as a call to a helper, shows as
code, which you can open or replace.

The same view opens for any model, with or without a resource: click
**Access** in the model designer, **Open in Access** above a policy's class, or
run **Laravel: Model Access…**.

A model without a policy gets one with **Create a policy**, which runs
`make:policy` and starts with everything allowed, so no one is locked out.
New permissions are named as Filament Shield names them, such as `update_post`.
With Shield installed, the Access tab asks Shield for the resource's permission
names, so they match what Shield generates, including the app's own naming
when it has one. When Shield lets its super admin role past every rule, the tab
says so.

With spatie/laravel-permission, **Roles and permissions** shows which roles
have the permissions the rules name. Check a box to grant one, creating the
permission when it's missing, and **New role** adds a role. These change the
app's database.

Custom pages and widgets have **Access** too: who can open the page, or see the
widget, is **Everyone**, **Nobody**, **Only users who…** have a permission or a
role, written in its `canAccess()` or `canView()`, or, with Filament Shield,
**Filament Shield decides**, which adds Shield's `HasPageShield` or
`HasWidgetShield` trait and shows the permission Shield gives it, such as
`page_Settings`, with the roles that have it. A page someone can't open also
leaves their navigation.

With Filament Shield, **Generate with Shield…** runs `shield:generate` for each
panel: **Create the permissions** for every resource, page, and widget, or
**Also write missing policies**, which leaves existing policies alone.

### Languages

When text is written with `__()`, the designer helps translate it:

- **Preview:** pick a language beside the designer's title, and the canvas
  shows each `__()` text, and each label with `translateLabel()`, in that
  language. Arabic, Hebrew, Persian, and Urdu lay out right to left.
  **Add a language…** adds a JSON file for a new one.
- **Translate:** a label, heading, placeholder, or other text shows its
  translation in each of the app's languages below it, to edit in place. A
  missing one shows the text people see instead. Plain text has a
  **Translate** button that writes it with `__()`. Changing a translated text,
  or a label with `translateLabel()`, renames its key in the JSON files too.
- **Make translatable:** with nothing selected, the inspector counts the texts
  written as plain strings, and one click writes them all with `__()`.

Translations go in `lang/<language>.json`, which Laravel reads first for any
key. A translation that's already in a PHP file, such as
`lang/ar/orders.php`, is changed there.

### New resources

**Filament: New Resource…**, the **+** in the Designers tool window, or
**Filament resource** in the model designer opens a wizard:

1. **Model:** pick one of the app's models, or design a new one.
2. **Placement:** the panel, cluster, navigation group, icon, record names,
   title attribute, and pages: separate pages or one page with modals, and a
   View page.
3. **Form:** which columns become fields, the field for each, and whether
   they're required or full width. Tusk proposes them from each column's type,
   cast, and name, so a foreign key is a relationship select.
4. **Table:** the columns and whether each is searchable, sortable, or can be
   hidden, the filters, the row and bulk actions, and the default sort.
5. **Review:** a summary and the form's and table's code.

Filament's generator (`make:filament-resource`) makes the files, so they follow
the project's Filament version and published stubs. The wizard then fills in
the form, table, infolist, and settings, and opens the designer.

### Relation managers, pages, and settings

- **Relations:** lists the resource's relation managers. **Add relation
  manager** creates one for a relationship of the model, with attach or
  associate actions, and registers it. Click one to design its form and table.
- **Pages:** lists the resource's pages and their addresses, and adds View,
  Create, Edit, or custom pages.
- **Settings:** sets the navigation label, icon, group, and order, the record's
  names and title attribute, the URL, a record count badge, and the attributes
  global search looks in.

### Panel settings

Click **Settings** under a panel in the Designers tool window, **Open Panel
Settings** above a panel provider's class, or run **Filament: Panel
Settings…**. Each change is saved to the provider at once, and a preview of
the panel follows it.

- **Brand:** name, logo and dark mode logo (a file in `public/` or a URL),
  logo height, favicon, and font.
- **Colors:** each of Filament's colors from its palettes, or any color.
- **Sign-in:** login, registration, password reset, email verification, and
  the profile page.
- **Layout and features:** top navigation, collapsible sidebar, content width,
  breadcrumbs, dark mode, global search, the notifications bell, single-page
  navigation, and strict authorization.
- **Navigation groups:** their order, icons, and whether they start
  collapsed, with the groups resources use that aren't listed yet.
- **Plugins:** the Filament plugins installed with Composer, added to the
  panel or removed from it.
- **Two-factor sign-in:** codes from an authenticator app, with recovery
  codes, or by email, and whether everyone must use it. **Set it up** gives
  the user model Filament's contracts and traits, adds their columns with a
  migration and runs it, and turns the profile page on, where people set it up.
- **Tenancy:** the tenant model. **Set it up** makes the user model implement
  `HasTenants` through its relationship to the tenant model, and the section
  lists resources' models that don't belong to a tenant yet.

Settings written as code the designer doesn't write, such as a logo from a
closure, show as code and open it.

### Import and export

Add an **ImportAction**, **ExportAction**, or **ExportBulkAction** from the
palette, and its **Importer** or **Exporter** setting picks one of the model's,
or makes a new one from the model's columns with Filament's generator. Click
it, or **Open in Import Designer** above an importer's class, to design it:

- **Columns:** each CSV column's heading; for imports, whether the file must
  have it, how its value is read (text, a number, yes or no, or a list), its
  validation rules, and an example value; for exports, whether it starts
  checked. Add the model's other columns, reorder, and remove.
- **Records:** whether each imported row makes a new record, updates the one
  with the same value in a column (such as `sku`) or makes it, or only
  updates.
- **What it needs:** the tables imports and exports use, with a button that
  creates them, and whether a queue worker must run.

The preview shows the CSV: the example people download before importing, or
the columns an export writes.

### Custom pages

Pages that aren't a resource's are listed under **Pages** in each panel in the
Designers tool window, and open in the designer: their form or table, header
actions, access, and navigation settings (label, icon, group, order, title,
and address). **Open in Designer** shows above a page's class too.

**New page** (the page button on a panel, or **Filament: New Page…**) makes:

- **A form** that edits one record: the signed-in user's, or a model's single
  record, such as the store's settings, made when it's first saved. Its
  fields come from the model's columns, and **Save** saves them.
- **A table** of a model's records, with columns from the model.

New pages draw their content from `content()`, so they need no Blade view.

### Dashboards and widgets

Click **Dashboard** under a panel in the Designers tool window, or run
**Filament: Dashboard…**. The dashboard shows its widgets in a grid, as wide
as each one is.

- **Arrange:** move widgets earlier or later, change how many columns each
  spans, and the dashboard's column count. Hide a widget, and show it again
  from **Hidden widgets**. A dashboard page that lists its own widgets changes
  that list instead.
- **New widget:** a stats overview, a chart, or a table of a model's records.
  It starts useful: a stat that counts the records, a chart of new records per
  month, or a table of the latest ones.
- **Stats:** each stat's label, value, description with its icon, color, and a
  trend of the last 7 days. A value counts a model's records, or sums,
  averages, or finds the lowest or highest of a column, of the records that
  match its conditions, in a time window, shown as it is, as a number, as
  1.2K, or as money.
- **Charts:** the type (line, bar, pie, doughnut, polar area, or radar), the
  heading, color, and height, and the data: a value over the last days, weeks,
  or months, or split by a column's values. Pies get a color per part.
- **Table widgets** open in the designer's table tab.
- **Following the table:** a resource's widget can count the records its list
  page shows, with the table's filters and search, with **Follows the table**.
- **Access:** who can see a widget, as for pages below.
- **Resource pages:** the **Page actions** tab lists the widgets above the
  page, to add, reorder, and remove, and makes new ones for the resource.

The preview runs the widget to show its real numbers, as the first user when
there is one.

### Navigation

Click **Navigation** under a panel in the Designers tool window, run
**Filament: Navigation…**, or click **Navigation…** in the panel settings'
navigation groups. The panel's sidebar shows as Filament builds it: its groups
in order, then each group's pages, resources, and clusters with their icons,
labels, and badges, and items nested under their parent item. A cluster shows
the resources and pages in it below it.

- **Reorder:** drag an item within its group, or select it and press
  <kbd>⌥↑</kbd> or <kbd>⌥↓</kbd>. Each project item in the group gets a
  `$navigationSort` in the new order.
- **Move to another group:** drag the item onto the group, or pick the group
  in the inspector. The group is written the way the project writes it: a
  label, a translated `__()` label, or an enum case. Drop an item on **Drop
  here for a new group** to start one.
- **Reorder groups:** drag a group. The panel's `navigationGroups([...])`
  lists them in the new order, keeping each group's icon and other settings.
  Groups from an enum come in the order of its cases.
- **Rename a group:** select it and change its name. Every file that names it
  changes, and so does the panel's list and, for a translated name, its
  translations.
- **Clusters:** **New cluster** makes one with Filament's generator, after
  adding `discoverClusters()` to the provider when the panel doesn't discover
  clusters yet. Drag a resource or page onto a cluster, or pick the cluster in
  the inspector, to move it in; the files stay where they are.
- **One item:** the inspector changes its label, icon, group, parent item,
  cluster, and whether it shows in the navigation. A hidden item stays in the
  list, crossed out, so you can show it again. Right-click an item for the same
  actions, or double-click it to open it in the designer.

A setting a method decides, such as a `getNavigationSort()` the designer
didn't write, shows as code and the item can't be moved, since a property would
be ignored; the inspector says why and opens the method. Items from packages,
and items the provider adds with `navigationItems()`, are read only. Badges
show what the app returns now, and can't be changed here.

### Sample records and checks

- **Sample records:** **Sample records** in the model designer, or **Laravel:
  Add Sample Records…**, makes as many records as you ask for with the
  model's factory, in the app's database.
- **Translated names:** in a resource's or page's settings, **Translate**
  beside the label, group, record names, or title writes it as a getter that
  returns `__('…')`, with a field for each language. A group's name must be
  translated the same way in the panel's navigation groups for their order to
  apply.
- **When the app stops starting:** after a change to `app/`, the app is read
  again, and a notice says when it can't start, with the file and line; another
  says when it starts again. **Laravel: Check the App (Boot and Tests)**
  loads the routes and runs the tests in a terminal tab.

### Generated tests

**Generate tests** (the beaker in the resource designer's header), **Generate
Tests** in a resource's menu in the Designers tool window, or **Filament:
Generate Resource Tests…** writes tests for a resource to
`tests/Feature/Filament/<Resource>Test.php` and runs them. The New Resource
wizard's last step has the same option. The tests check that:

- The list page shows records and the table's columns.
- A record can be created and edited with the form, and its values are saved.
  An edit also checks that the form shows the record.
- Each required field is required, and each unique field rejects a value
  another record has.
- The View page opens.
- A user the policy refuses can't open the list, create, edit, or view pages.

A simple resource, with one page and modals, is tested through its **New** and
**Edit** actions.

- **Values:** the tests fill the form with the model's factory, and give
  fields the factory doesn't fill a value for their type. When a model the
  tests need has no factory, Tusk offers to make one, with a fake value for
  each column, and adds `HasFactory` to the model.
- **Who acts:** a user from the user model's factory, with the permissions and
  roles the policy's rules ask for. With spatie/laravel-permission, the tests
  create them. A rule Tusk can't read gets a comment that asks you to set the
  user up.
- **Pest or PHPUnit:** a project with Pest gets Pest tests. Without Pest, you
  choose PHPUnit tests or installing Pest first.
- **Your code:** a test file that exists isn't overwritten. Tusk offers to add
  the tests it lacks, such as one for a field that became required, or to open
  it.

The tests run in the Tests tab, and **Laravel: Check the App (Boot and Tests)**
runs them with the app's other tests.

## Model designer

The model designer creates an Eloquent model or changes one and its table. To
open it, click **Open in Model Designer** above a model's class, run
**Laravel: New Model…** or **Laravel: Open Model in Designer…**, or click the
model's name in the Filament designer.

- **Columns:** each column's name, type, length or precision, whether it can be
  null, default, index, whether it's fillable, and its cast, which is chosen
  from the type unless you pick an enum. A foreign key names its table and what
  happens when the other row is deleted. **Quick add** adds common columns, such
  as a slug or a price. Drag rows to reorder them.
- **Relationships:** belongs-to, has-one, has-many, many-to-many, and morph
  relationships. A belongs-to relationship adds its foreign key column, and a
  many-to-many relationship adds its pivot table. You can add the other side of
  the relationship to the related model too.
- **Preview:** the right side shows the migration, the model, and the factory as
  they'll be written.

Changes are staged until you click **Create model** or **Apply changes**. A new
model gets its class, a migration, and optionally a factory that fakes each
column, a seeder, a policy, and a Filament resource. For an existing model,
Tusk writes a migration with only the changes, such as
`add_description_to_posts_table`, with a `down()` that reverses them. It edits
the model's fillable attributes, casts, soft deletes, and relationships in
place, and keeps everything else. Dropping a column asks first. **Run the
migration** runs `php artisan migrate` afterwards, in Sail when it's up.

### Record history

Record history keeps who created, changed, or deleted each record, and what
changed, with
[spatie/laravel-activitylog](https://github.com/spatie/laravel-activitylog).
To turn it on for a model, open the **History** section at the bottom of the
model designer, or run **Laravel: Record History…** and pick the model.

- **Install:** when the package isn't installed, **Install
  spatie/laravel-activitylog** runs Composer, publishes the package's migration
  and config, and runs the migration, in a terminal tab. When the package is
  installed but its table isn't, the section offers to run the migration.
- **Record history:** adds the `LogsActivity` trait and its
  `getActivitylogOptions()` to the model. The settings are the calls on
  `LogOptions::defaults()`: which attributes it records (chosen ones, the
  fillable ones, all of them, or only the event), **Only changed values**
  (`logOnlyDirty()`), **Skip empty entries**, a log name, and a description
  with `{event}` for created, updated, or deleted. Turning it on picks the
  table's columns without the key, timestamps, and hidden attributes such as a
  password. Unchecking an attribute when it records all of them adds it to
  `logExcept()`.
- **Latest entries:** the section lists the last ten entries for the model's
  records, with who made them and the old and new values, so you can see that
  logging works.

Changes are staged with the model's other changes until you click **Apply
changes**. Calls the designer doesn't know, such as
`dontLogIfAttributesChangedOnly()`, are kept and show as code. So does a
method written as code, such as one with statements before its `return`.

To show a record's history in Filament, turn on **Show history on the
record's page** in the resource designer's **Settings** tab. It writes
`ActivitiesRelationManager`, a read-only relation manager titled **History**,
next to the resource, and adds it to `getRelations()`. It lists each entry
under the edit and view pages: when, who, what happened, and each changed
attribute as `title: Old → New`. It opens in the designer like any other
relation manager. Turning the setting off removes it from `getRelations()` and
keeps its file.

## Enum designer

The enum designer creates a PHP enum or changes one: its cases, their values,
and the labels, colors, icons, and descriptions Filament shows in selects,
badges, and filters. To open it, click **Open in Enum Designer** above an enum,
run **Laravel: New Enum…**, pick **New enum…** as a column's cast in the model
designer, or use the Enum options of a select in the Filament designer, where
**Make an enum of these** turns a list of options into an enum.

- **Cases:** name, value, label, color, and icon for each case. Type several
  values at once, such as `draft, published, archived`. Drag rows to reorder
  them.
- **Filament shows:** turns `HasLabel`, `HasColor`, `HasIcon`, and
  `HasDescription` on or off, which adds or removes the method.
- **Translated:** labels and descriptions go through `__()`. A
  **Translations** card then shows each one in each of the app's languages, to
  fill in. Translations are written with the enum when you apply, and a
  renamed label takes its translations along.

Changes are staged until you click **Create enum** or **Apply changes**, with
the code previewed. A method the designer can't read, such as an icon that
comes from a helper, shows as **In code** and is kept. A renamed case is renamed
there too. When a new case is missing from such a method, the designer says so
and opens the method after applying.

## Environment settings

The environment settings edit the values in `.env` that password reset, email
codes, notifications, and imports and exports depend on. To open them, run
**Laravel: Environment Settings…**, click **Open in Environment Settings**
above the project's `.env`, or click **Environment** under **App designers** in the
Designers tool window. Each change is saved to `.env` at once, like typing it there: comments,
order, and quoting stay as they are, and a new key goes after the others of its
group, such as `MAIL_HOST` after `MAIL_PORT`.

- **App:** name, environment, debug mode, URL, language, and time zone. A
  missing `APP_KEY` can be generated. Laravel 11 and later set the time zone in
  `config/app.php` rather than reading `APP_TIMEZONE`, so the time zone then
  edits `config/app.php`, and **Read it from .env instead** makes it read
  `APP_TIMEZONE`.
- **Mail:** the mailer, from the mailers in `config/mail.php`. SMTP shows the
  host, port, username, password, and scheme; other services, such as Resend,
  Postmark, or SES, show the keys `config/services.php` reads for them. Then
  the from address and name. **Send a test email** sends one with Tinker, using
  the app's own settings; with the log mailer, it opens the log.
- **Queue:** the connection. `sync` gets a warning, since Filament's imports
  and exports need a real queue and a worker; **Run a worker** runs
  `queue:work` in a terminal tab. The database queue offers to create its
  table when it's missing.
- **Storage:** the default disk, with an S3 disk's keys, and **Link it** when
  `public/storage` is missing.
- **Cache and sessions:** the cache store, the session driver, and how long
  sessions last, with their tables for the database drivers.

Passwords and keys are masked, and messages name the key, never its value.
When a value the booted app uses differs from `.env`, the row says so: the
config is cached, or the config file doesn't read the key. With a cached
config, **Clear the config cache** runs `config:clear`. A key new to `.env` can
be added to `.env.example` too, with secrets left empty.

## Automations

Automations are rules such as "when an order's status becomes shipped, email
the customer". Tusk writes them as the model's observer. To open them, click
**Automations** in the model designer, **Open in Automations** above an
observer's class, or run **Laravel: Automations…**.

- **When:** the record is created, updated, deleted, or restored (with soft
  deletes), a field changes, or a field becomes a value, such as an enum case.
- **If:** optional conditions that compare the record's fields with values,
  such as `total` is at least 100. Enum fields offer their cases.
- **Then:** send a notification, or set a field. A notification goes to every
  user, users with a role, the record's user (such as the order's
  `customer`), the signed-in user, or an email address. Pick from the app's
  notifications that take the model, or none, or make one with **New
  notification…**, which opens the Notifications designer.

Each change is saved at once. The first rule creates
`App\Observers\OrderObserver` and registers it on the model with
`#[ObservedBy]`. An observer the app registers elsewhere, such as with
`Order::observe()` in a provider, is used as it is. Fields are set before the
save, in `creating` or `updating`, so they're saved with the record;
notifications are sent after it, in `created` or `updated`. A rule that does
both is written in both methods under the same condition. A queued
notification (one that implements `ShouldQueue`) is sent only while a queue
worker runs, which the rule says. Code in the observer the designer can't read
shows as code you can open, and stays as written.

## Scheduled tasks

The schedule designer shows the app's scheduled tasks and changes them in
Laravel's scheduler: what runs, when, and how. To open it, run **Laravel:
Scheduled Tasks…**, click **Open Scheduled Tasks** in `routes/console.php`, in
`bootstrap/app.php` when it has `withSchedule()`, or in an older
`app/Console/Kernel.php`, or click **Schedule** under **App designers** in the
Designers tool window.

- **Tasks:** an Artisan command with its arguments, picked from the project's
  own commands; one of the app's queued jobs; a notification sent to every
  user, the users with a role, or an email address; or **Delete old records**,
  which schedules `model:prune`. **Add task** writes the new task beside the
  existing ones, or in `routes/console.php`.
- **When:** every few minutes, hourly, daily at a time, weekly on a day at a
  time, monthly on a day at a time, or a cron expression. The next three runs
  show in the task's time zone, or the app's.
- **Options:** a time zone, the environments the task runs in, **Skip while
  still running** (`withoutOverlapping()`), **On one server**
  (`onOneServer()`), and **In the background** (`runInBackground()`).
- **Run now:** runs a command directly, and other tasks with
  `php artisan schedule:test`, in a terminal tab.
- **Old records:** each prunable model with the records `model:prune` deletes:
  those older than some days, by a date column, that match conditions such as
  `status is cancelled`. **Add a model** makes a model prunable with Laravel's
  `Prunable` trait and a `prunable()` query. A model with soft deletes loses
  those records for good.

Laravel runs the tasks only while its scheduler runs. The side panel says so,
runs `php artisan schedule:work` in a terminal tab while you develop, and gives
the line to add to a server's crontab:
`* * * * * cd /path/to/app && php artisan schedule:run >> /dev/null 2>&1`.

Each change is saved in the code as you make it, as in the Filament designer.
A task the designer can't read, such as a closure of the app's own, shows as
code, and you can still change when it runs. Calls it doesn't write, such as
`when()` or `emailOutputTo()`, stay as they are.

## Notifications designer

The notifications designer creates and changes a notification class: what
shows in the panel's bell, and the email. To open it, click **Open in
Notifications Designer** above a notification's class, run **Laravel: New
Notification…** or **Laravel: Open Notification in Designer…**, or click
**Notifications** under **App designers** in the Designers tool window.

- **New notification:** a class name, the model it's about (or none, as for a
  weekly report), and whether it goes to the bell, by email, or both. Tusk
  writes it in `app/Notifications` with a title that names the record and a
  button that opens the record's page.
- **Sent to:** turns the bell and email on or off. Turning one on adds its
  part when the class doesn't have it; turning it off keeps it.
- **Bell:** the title, body, icon, and status, which colors the icon, and
  buttons that open the record's view or edit page, a resource's list, or a
  web address, and can mark the notification as read.
- **Email:** the subject, greeting, lines before and after the button, the
  button, and the salutation.
- **The record's fields:** **+ Field** puts a field in a text, such as
  `Order {number} shipped`, or a related record's field, such as
  `{customer.name}`. Texts written with `__()` stay translated.
- **Preview:** the bell notification and the email, with sample values for the
  record's fields.
- **What it needs:** says when the database lacks the notifications table,
  with **Create it**; when no panel shows the bell, with **Turn it on**; and
  when the app's mailer is `log` or `array`, so emails aren't delivered, with
  a link to `.env`.
- **Sending it:** shows the code that sends it to every user, users with a
  role, the record's user, the signed-in user, or an email address. In the
  Filament designer, an action button sends it with **What it does > Send a
  notification**.

Each change is saved as you make it. Calls the designer doesn't write, such as
`->cc()`, and texts written as other code show as code and are kept.

## Settings designer

The settings designer creates or changes a settings class of
[spatie/laravel-settings](https://github.com/spatie/laravel-settings): app-wide
values, such as a tax rate or the site's name, kept in the database. To open
it, click **Open in Settings Designer** above a settings class, or run
**Laravel: Open Settings in Designer…**, which also offers **New Settings…**.
When the package isn't installed, the designer installs it with Composer, with
Filament's settings page plugin for your Filament version, then publishes its
migration and config and migrates, in a terminal tab.

- **Properties:** each property's name, type (text, whole number, decimal,
  yes or no, list, date and time, or one of the app's enums), and whether it
  can be null. Drag rows to reorder them. A type the designer doesn't write,
  such as a data object, shows as **In code** and stays as written.
- **Group:** the values are stored as `group.property`, such as
  `general.tax_rate`. Changing the group renames the stored values.
- **Stored values:** the value column shows what the app stores now. Change
  one and Apply updates it. A new property's value is its first value.
- **Read it in code:** `app(\App\Settings\GeneralSettings::class)->tax_rate`,
  or the class injected into a controller, job, or command, with a copy
  button. Each property's copy button copies its own line.
- **Settings page:** **Make a settings page**, or **Filament: New Settings
  Page…**, makes a Filament page with a field for each property and opens its
  form in the designer, where the settings' properties are the palette's
  columns. Settings pages are listed under **Pages** in the Designers tool
  window; right-click one to open its settings.

Changes are staged until you click **Create settings** or **Apply changes**,
with the class and the settings migration previewed. Tusk writes a new
settings migration in `database/settings` each time, with `add`, `rename`,
`delete`, and `update` calls, and never edits one that exists, since each runs
once. **Run the migration** runs `php artisan migrate` afterwards. **Add
fields to …** adds a form field for each new property to the class's settings
page. A class outside the folders the package discovers is listed in
`config/settings.php`.

## New Laravel projects and elements

**New Laravel Project…** on the welcome screen or in the palette creates a
project with Laravel's own installer. Tusk keeps a copy of `laravel/installer`
in its tools folder and installs it with its bundled Composer the first time,
so nothing is installed globally. The dialog chooses:

- The folder and name.
- The starter kit: none, Livewire, React, Vue, Svelte, or a community kit by its
  package name, with Laravel's authentication, WorkOS, or none, and teams.
- The database, the test framework (Pest or PHPUnit), the front-end package
  manager, a Git repository, and Laravel Boost.
- An admin panel: Filament with its first panel and, on SQLite, a first user.

It runs in a terminal tab, where you can follow it, and the project opens when
it succeeds.

**Laravel: New Element…** lists every `make:` command the project's Artisan
has, Laravel's and packages' alike, such as Filament's, Livewire's, or an MCP
server's. Choosing one opens a form built from the command's own arguments and
options, with the command line it will run, and opens the files it makes. The
model and resource generators open the model designer and the resource wizard
instead; their plain forms are listed too.

## Bookmarks

Press F3 to bookmark the current line, and F3 again to remove the bookmark. A
bookmark shows as a blue marker in the gutter and moves with its line as you
edit. You can also right-click the gutter at a line and choose **Add
Bookmark**.

Press ⌥F3 to give the line's bookmark a mnemonic, a digit or a letter, which
the gutter shows instead of the marker. Type the character and press Enter.
⌃1 to ⌃9 jump to the bookmark with that digit. Choosing a mnemonic another
bookmark has moves it to this line.

⌘F3 opens the **Bookmarks** tab in the bottom panel. It groups bookmarks by
file and shows each line's code, even for files that aren't open, with its
mnemonic and description.

- Enter or a double-click goes to the bookmark; ↑ and ↓ move, → and ← open and
  close a file, and typing jumps to a bookmark by its code or description.
- F2 (or the pencil) edits the description in place: Enter keeps it, Escape
  cancels.
- Delete removes the selected bookmark, or a file's bookmarks when a file is
  selected. **Remove all** asks first.
- Drag a bookmark within its file, or a file among the others, to reorder
  them.

Bookmarks are saved in the project's local state, not in `tusk.json`, and
bookmarks from earlier versions move there the first time you open the
project.

## Docblocks

In PHP files, pressing Enter in a `/** … */` docblock starts the new line with a
`*` lined up under the one above, and with the same spaces after it, so what you
type next lines up with the text above, such as an array shape's next key.
Pressing Enter after `*/` goes back to the indentation of the `/**`. Tab in a
docblock line moves to tab stops counted from the text after `* `, not from the
start of the line.

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
only if nothing uses it. The editor looks for usages with the PHP server, and also
searches the project's PHP files for the names Laravel uses: a class's full
name in strings (as in config files), and a method's name, its scope name
(`scopePublished` as `published`), or its attribute name (`getFullNameAttribute`
as `full_name`). So `->relationship('author')` counts as a use of `author()`.

- If something uses it, the palette lists the usages. Choose one to open it,
  or choose **Delete anyway**.
- If nothing does, confirm in the palette. A method or function is removed with
  its docblock and attributes (undo with ⌘Z). A class that's alone in its file
  moves the file to the Trash.

## Refactor This

Press ⌃T to list the refactorings that apply at the caret or to the selection,
with their shortcuts, as PhpStorm's **Refactor This** does. The refactorings'
choices open in a small popup below the caret: press a row's number (1 to 9)
or ⏎ to choose, or type to filter. The popup highlights in the editor what each
choice would change. The list: Rename, Change
Signature, the three Extracts, Introduce Field and Parameter, Inline, Pull Members Up, Extract Interface,
Move Class, and Safe Delete, plus
the PHP server's other refactoring actions there. The **Refactor** menu has them all.

## Extract variable, constant, and method

Press ⌥⌘V to put an expression in a new variable. With nothing selected, a
popup at the caret lists the expressions around it, from the innermost, such
as `$item['price']`, `$item['price'] * $item['qty']`, and the whole product.
The PHP server reads the code, so a whole ternary, a `match`, a heredoc, a
closure, or the call that takes the expression is offered too, and the editor
highlights each as you move through the list. A selection that covers only part
of an expression, such as `unt($ite` in `count($items)`, grows to the smallest
whole expression around it, and the status bar says so.

- When the same expression appears more than once in the function, choose
  **Replace all N occurrences** or **Replace this occurrence only**. The editor
  highlights the occurrences, and the scroll bar marks them. Spacing and
  comments don't matter, and a closure's copies, which read its own variables,
  aren't counted.
- The assignment goes before the statement that holds the first use, in the
  innermost block that holds them all, so it lands inside a loop, an `else`, or
  a `case` when the uses are there. A statement that's only the expression,
  such as `foo();`, becomes the assignment. Inside a string, as in
  `"Hi $user->name"`, the variable is written `{$name}`.
- The server suggests a name from the expression: `$user->getEmail()` gives
  `$email`, `$item['unit_price']` gives `$unitPrice`, `new Invoice()` gives
  `$invoice`, and a value of a class type the class's name. Every copy of the
  name is framed; type another name and every copy follows. A hint above it
  reminds you that ⏎ or Escape finishes, and ⌘Z undoes the whole extraction.
- When an occurrence runs only sometimes, such as on the right of `&&` or `??`,
  in a ternary's branch, or in a `match` arm, the occurrences popup says so:
  **Will run every time, not only when $n > 1 is true**. With one occurrence,
  the hint above the new name says it. For Introduce Parameter, an enclosing
  `if` or `else` counts too, since every call would compute the value.
- When the expression can't be extracted, a hint at the caret says why: it's
  written to (`$a['x'] = 1`), it uses an arrow function's parameters, or it's
  a declaration's default value, for example.

**Extract variable**, **Extract constant**, and **Introduce field** are also in
the ⌥⏎ menu on a selection, and run the same way.

Press ⌥⌘C on a string or number, or on an expression of literals and
constants, such as `self::LIMIT * 2`, to extract a class constant. It works the
same way: choose among the constant expressions around the caret, choose the
occurrences in the class, and type the name. `'pending review'` suggests
`PENDING_REVIEW`. The constant is `private` (`public` in an interface) and goes
after the class's other constants, or after its trait uses and enum cases, or
at the top. Uses become `self::NAME`, in property defaults and other constants
too.

Press ⌥⌘F in a method to put an expression in a new private property,
PhpStorm's **Introduce Field**. A constant expression, such as `1.14`, becomes
the property's default; anything else is assigned with `$this->name = …` before
its first use, and its uses become `$this->name` (`self::$name` in a static
method). The property goes after the class's other properties, or after its
constants, typed with the expression's type from the analyzer, with an import
when it names a class.

Press ⌥⌘P to make an expression a new parameter of its method, PhpStorm's
**Introduce Parameter**. The **Change Signature** dialog opens with the
parameter added, named and typed by the server, and its name selected; a
constant expression becomes its default, and anything else the value passed in
existing calls. The expression can't use the method's variables or `$this`,
which don't exist at the calls, nor, unless it's a constant, `self`, `static`,
or `parent`, which would name the calling class.

When you only add the parameter in the dialog, the PHP server writes the
change: the declaration, the methods that override it, and every call,
including `new` for a constructor. A call passes the expression, with an
import when it names a class, and a call that leaves out optional arguments
before the new parameter passes it by name. A parameter without a default
can't go on a method that overrides, or is overridden by, another one, whose
signatures must still match. Other editors get **Introduce parameter** as a
code action.

Press ⌥⌘M to extract the selection, or an expression chosen as above, into a
method. The PHP server writes the method with its parameters and return type; you
then type its name in place.

## Inline

Press ⌥⌘N on a variable, a constant, or a method or function, at its
declaration or at a use, to replace its uses with its value or body, as
PhpStorm's **Inline** does. The PHP server reads the code and writes the edit.
A popup at the caret offers the choices: inline every use and remove the
declaration, inline every use and keep it, or inline only the use under the
cursor. The editor highlights what each choice changes. When the change would
make something run differently, such as a call that would run three times
instead of once, each choice says so, and you decide. ⌘Z undoes the whole
change, in every file it touched.

- The value gets parentheses only where the code around it would bind tighter:
  `$total * 2` with `$total = $a + $b` becomes `($a + $b) * 2`, and
  `[$total]` becomes `[$a + $b]`. In a string, a value that starts with `$`
  goes in braces, as in `"Hi {$user->name}"`. A heredoc or a multi-line array
  moves with its lines' indentation.
- When it can't inline at all, a hint at the caret says why. Places it has to
  leave, such as a call from another class to a method that reads private
  properties, show in the **Refactoring Preview** with the reason, and the rest
  applies from there.
- Other editors get it as a `refactor.inline` code action, which inlines every
  use.

**Variables.** Inline works on a variable that a statement of its own assigns
once, as `$total = $a + $b;`, in the block that holds its uses. It refuses, and
says why, when the variable is a parameter, a closure captures it with `use`,
something changes it later (including a function that takes it by reference,
such as `sort($items)`), a variable its value reads changes before a use, or
the function reads its variables by name with `compact()` or `extract()`.

**Constants.** On a class constant or a global `const`, its uses take its
value. Uses through subclasses count, unless a subclass declares its own. The
value's names are written so they mean the same in each file: `self::BASE`
becomes `Order::BASE` elsewhere, and a class the file doesn't import gets a
`use` line. A use that can't reach what the value names, such as a private
constant, is left. A constant declared with others in one statement is removed
from it alone. Enum cases are objects, not values, so they can't be inlined.

**Methods and functions.** Calls take the body.

- Arguments take their parameters' places. An argument that does more than
  read a value, such as `$this->load()`, and that the body reads more than
  once, in a closure, or after other code runs, goes into a variable first, in
  argument order; so does one the body changes. Named arguments find their
  parameters, and a missing argument gets the default.
- `$this` becomes the object the call was made on. In another class, `self`
  and `__CLASS__` name the method's class, and class names get imports. A local
  variable whose name the caller already uses gets a number, such as `$sum2`.
- A call that's a statement of its own becomes the body's statements. A call
  whose value is used becomes the method's `return` expression, with any
  statements before the statement that holds it.
- It refuses, and says why, for a method that returns early, a generator, one
  with static variables, by-reference or variadic parameters, or
  `__METHOD__`, and one a subclass overrides. It leaves a nullsafe call
  (`?->`), a first-class callable such as `$this->total(...)`, and a call from
  another class to a method that uses members private there. A method that
  calls itself, or implements another class's method, stays.

## Change signature

Press ⌘F6 in a method or function to open the **Change Signature** dialog, laid
out as PhpStorm's:

- Change the visibility, the name, and the return type.
- Edit each parameter's type, name, and default value. **Add Parameter** or ⌘N
  adds one after the focused row, the arrows or ⌥↑ and ⌥↓ reorder them, and the
  trash button removes one.
- A new parameter needs a default value or a **Value in existing calls**, which
  goes into every call without becoming a default.
- The new signature shows as you type, and a problem, such as two parameters
  with one name, disables **Refactor**. An optional parameter before a required
  one gets a warning, since PHP deprecates it.

The signature below the table is colored as the editor colors PHP.

**Refactor** (⏎) applies the change; **Preview** first opens the **Refactoring
Preview** panel, which lists every changed line by file, with the removed and
added tokens marked. Click a file to fold it, or a line to open it. **Do
Refactor** there applies it, and Escape cancels. The preview also opens on its own
when some calls can't be rewritten, listing them under **Left unchanged**.

The editor rewrites the declaration and every call: positional arguments move
with their parameters, named arguments stay named (under a parameter's new
name), and once an argument must be named, the ones after it are named too. A
renamed parameter is renamed in the body and the docblock. A default written
into a call is spelled so it means the same there, such as `self::LIMIT`
becoming `Order::LIMIT`. Methods in subclasses and implementing classes that
override it change with it, keeping their own parameter names, parameters of
their own, and return type unless you renamed or changed one. For a constructor, the calls
are `new` of the class and of subclasses that inherit its constructor, `new
self` and `new static` inside them, and `parent::__construct()` in subclasses;
a subclass's own constructor keeps its parameters, and a promoted property is
renamed with Rename instead. Arguments one per line stay one per line. Calls it
can't rewrite safely, such as ones that spread `...$args`, are left unchanged.


## Pull members up and extract interface

Both start from the class at the caret: choose **Pull Members Up…** or
**Extract Interface…** from ⌃T or the **Refactor** menu. A dialog lists the
class's members with their signatures, colored as in the editor.

- Check the members to move. Click a row, or use ↑ and ↓ and Space; ⌘A
  selects every member shown, and the filter box narrows a long list. A member
  that can't move says why instead of offering a checkbox.
- Below the list, the dialog shows the code the members become, and
  warns about anything that would break. Where there's a fix, such as a method
  that uses a property you left behind, a button applies it.
- Click **Refactor**, or press ⏎, to apply the change and save the files. Click
  **Preview** to see every changed line first in the **Refactoring Preview**.
  One ⌘Z undoes it in every file.

**Pull Members Up** moves members to a parent class, or declares them in an
interface the class implements. Choose the target under **To**: the class's
parents, nearest first, and its interfaces. Classes in `vendor` are listed but
can't be chosen.

- Constants, properties, and methods move with their docblocks and attributes.
  Methods go at the end of the parent, and constants and properties after the
  parent's own.
- Check **abstract** on a method to declare it abstract in the parent and keep
  its code in the class. The parent becomes `abstract`, and the dialog warns
  about sibling classes that don't declare the method.
- Pulling a method into an interface adds its declaration there; the class
  keeps its code. Interfaces take public methods and constants only.
- A private member that the class still uses becomes `protected`, marked in
  the row. When a member you move uses one that stays, the dialog stops you if
  that one is private, which the parent can't reach, and warns otherwise,
  since the parent's other subclasses won't have it. It also warns about calls
  to `parent::`, whose meaning changes one level up.
- Class names in the moved code are rewritten for the parent's file: they keep
  their short names where its imports allow, get a new `use` import, or are
  written in full when a short name would mean another class. Imports the
  class no longer uses are removed.
- Functions and constants keep meaning the same ones: a helper declared in the
  class's namespace, or imported with `use function` or `use const`, is written
  in full when the parent is in another namespace, such as
  `\App\Services\format_amount()`. PHP's own, such as `strlen()`, stay as
  they are.
- A property promoted in the constructor, such as
  `private Client $client`, becomes a property of the parent; the constructor
  keeps the parameter and assigns it after any `parent::__construct()`. It
  becomes `protected`, since the constructor sets it. A `readonly` one needs
  PHP 8.4, which lets a subclass set it: the dialog blocks it when
  `composer.json` allows an older PHP. Pulling up the constructor itself takes
  its promoted properties with it.

**Extract Interface** creates an interface from the class's public methods and
constants, and makes the class implement it.

- Type the interface's name and namespace; the namespace field suggests the
  project's namespaces. The file goes where `composer.json`'s PSR-4 map puts
  that namespace, shown under the fields, or beside the class when the project
  has no map.
- Methods become declarations, with their docblocks unless you clear **Copy
  docblocks**, and constants move to the interface.
- The interface gets the imports its signatures need, and `declare(strict_types=1)`
  when the class's file has it. The class gets `implements`, and a `use` import
  when the interface is in another namespace.
- Check **Use it in type hints where possible** to type the interface instead
  of the class across the project, as PhpStorm does: a parameter used only to
  call the interface's methods and read its constants, and a private property,
  declared or promoted, used only that way. The option shows how many it
  changes; the **Refactoring Preview** lists the rest and why each stays, such
  as a parameter passed on to other code, or a method the interface doesn't
  declare. Docblock `@param` and `@var` types follow.
- In a Laravel app, **Bind it in AppServiceProvider** adds
  `$this->app->bind(Interface::class, Class::class)` to `register()`, so the
  container can still build what those type hints ask for.
- When it's done, a notice offers to open the new interface. ⌘Z removes the
  file, and the folder it made, along with every other change.

## Move class

Press F6 in a PHP file that declares one class, interface, trait, or enum to
move it to another namespace. The picker lists the project's namespaces, each
with the file it would become; type a new one, such as `App\Services\Billing`,
to create its folder. The file goes where `composer.json`'s PSR-4 map puts that
namespace, and the PHP server updates the class's namespace and every reference,
as when you move the file in the tree. If it can't, for example because no PSR-4
folder in `composer.json` holds the new path, the status bar says why.

## Undo across files

A refactoring that changes several files, such as Rename or Change Signature,
saves them all, and one ⌘Z in any of them undoes it in every file, as in
PhpStorm. A file you edit afterwards leaves the group, since its next undo is
no longer the refactoring's.

## Type hierarchy

Press ⌃H in a PHP file to open the **Hierarchy** tab. With the cursor on a
type's name, such as `Model` in `extends Model` or a trait in `use HasFactory;`,
the tab shows that type. Otherwise, it shows the class, interface, trait, or
enum that the cursor is in.

- **Subtypes** lists the classes that extend it or implement it directly,
  including classes in `vendor`. For a trait, it lists the types that use it.
  Expand one to see its own subtypes.
- **Supertypes** lists its parent class, its interfaces, and its traits.
  Expand one to go further up.

Click a type to open it. PHP's own types, such as `Countable`, are listed
without a file.

## Go to super method

Press ⌘U (**Navigate > Go to Super Method**) in a PHP file to go to the method
that the method at or around the caret overrides or implements, such as
`Model::casts()` from a model's `casts()` or `Resource::form()` from a
Filament resource. The caret can be on the method's name or anywhere in its
body. Outside a method, ⌘U goes to the class's parent class. When there's
more than one target, such as a parent's method and an interface's, pick one
from the list.

The gutter shows an arrow beside methods that override (blue) or implement
(green) another, and beside classes and methods that subclasses extend or
override. Hover over an arrow to see what it points to, and click it to go
there.

## Generate code

Press ⌘N in a PHP file, or choose **Code > Generate…**, to add code to the
class, trait, or enum at the cursor. The list offers what the class lacks:

- **Constructor**: takes and assigns each property that has no default value
  and isn't static. It's offered when the class has no constructor.
- **Getters**, **Setters**, and **Getters and Setters**: `getTitle()` and
  `setTitle()` for each property, including promoted ones, that doesn't have
  one yet. Readonly properties get no setter.
- **`__toString()`**, returning `''`.
- **Implement Methods…** and **Override Methods…**, when the class has
  interface or abstract methods to write, including abstract methods of the
  traits it uses, or parent methods to override. Override asks which method.
- **Complete Constructor**, **Promote Constructor**, and **Add missing
  properties**, when they apply.

## Call hierarchy

Press ⌃⌥H in a PHP file to open the **Call Hierarchy** tab for the method or
function called under the cursor, or else the one the cursor is in.

- **Callers** lists the methods and functions that call it, one row per call.
  For a constructor, that includes `new`, `new self`, `new static`, and
  `parent::__construct()`. Code outside a function, such as a route file, is
  listed by its file. Expand a caller to see its own callers.
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

- Click a request to preview it in the **HTTP** tab. The next request you click
  takes the preview's place, until you edit or send it. Double-click a request
  to keep its tab open. Hover over it and click ▶ to send it.
- A dot after a request means its tab has unsaved changes, and a dot after a
  file means its editor tab does.
- The tree and the history work from the keyboard: ↓ in a filter box moves to
  its list, ↑ and ↓ move, → and ← open and close a file, typing a name jumps to
  it, and Enter opens a request (a history entry's response). On a request, ⌘⏎
  sends it, F2 renames it, and ⌘⌫ deletes it. When the files can't be listed,
  the tree says why, with **Retry**.
- Right-click a request to send, open in the editor, rename, duplicate, delete,
  or stress test it. Right-click a file to add a request to it, run all of its
  requests, sync it with the Laravel routes, or save it.
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
  takes, its `validate()` or `Validator::make()` call, or those calls in a
  method of the controller it calls with `$this->`, with a value of the right type for each. A web
  route gets Laravel session auth, and an API route behind `auth:sanctum` a
  bearer token. When artisan fails, such as on an error while the app boots,
  the message says why.
- **Sync with Laravel Routes** (right-click a file, the first row of the
  method icon's list, or **HTTP Client: Sync with Laravel Routes…** in ⌘⇧A)
  brings a file in line with the routes. It lists what would change, each with
  a checkbox:
  - **New routes** get a request each, with a body from their rules.
  - **Changed bodies** get fields that the rules add, with an example value,
    and lose fields that no rule validates. Values you typed stay.
  - **No matching route** lists requests to `{{host}}` that no route answers.
    These aren't ticked, so they're only deleted if you tick them.

  Requests go with routes by method and path, so a route whose path changed
  shows as one new and one missing. A file that calls only API routes syncs
  with the API routes; switch to **All routes** at the top. **View Diff** shows
  the file before and after, and **Apply** makes the ticked changes as one
  undoable edit. The file saves unless it had unsaved changes, which then stay
  unsaved with the sync. If the file changes before you apply, the list is
  worked out again for you to check.
- **History** lists the last 100 requests you sent in the project, with their
  responses, and a filter. Click one to see it again. Right-click one to send it
  again, pin it (pinned requests stay at the top and don't count toward the
  100), compare it with the response on screen, or copy it as cURL or Laravel
  code. The history file doesn't keep secrets: tokens, passwords, cookies, and
  API keys in requests, and cookie values in responses. In response bodies, it
  hides the values of JSON and form fields named like `token`, `password`,
  `secret`, or `api_key`; you see the body as it came until you close the
  project, and a notice says when a body from the history had secrets hidden.
  **Settings › HTTP Client › Response bodies in the history** can keep bodies
  as they came, or not keep them at all. **Send Again** sends a request from this session exactly as it
  went, and prepares one from an earlier session again from its file, running
  its scripts.
- **Go to Request** (⌥⇧⌘O) finds any request in the project by name. Search
  Everywhere lists requests too.

### The HTTP tab

Each request you open gets a tab at the top of the **HTTP** tab, showing its
method and title, and its file when two tabs have the same title. A preview
tab's title is in italics. Drag tabs to reorder them. Middle-click or ⌘W (with
the **HTTP** tab focused) closes one. Right-click a tab to close others, those
to the right, the saved ones, or all of them, to keep a preview open, to save
or revert it, to save every unsaved tab, or to show it in the editor or the
tool window. ← and → move between focused tabs. Each tab keeps its own
response, and a request goes on sending when you switch to another tab. The
tabs, their unsaved changes, the one you had open, and whether the **HTTP** tab
showed come back when you reopen the project, after a reload, or after you
quit.

The top bar holds the method, the URL, **Send** (⌘⏎ anywhere in the tab), a
menu, and the environment. Under the URL, you see it with its variables
replaced, and the names nothing defines. While a request runs, **Send** becomes
**Cancel** and the time it's taken counts up. **Send Again** from the history
shows the same progress and **Cancel**. When a request can't be sent, or its
body can't be read, the response area says why, with **Retry**. Drag the line
between the request and the response to resize them, or focus it and use ←
and →; double-click it to reset it.

When a request uses a variable nothing defines, **Send** asks for its value
first. **Send** uses the values you type, and can save them to the environment
in the private environment file. **Send Anyway** sends `{{name}}` as written.

Changes in the request's tabs belong to its request tab until you save it:
the tab shows a dot, and the `.http` file doesn't change. ⌘S (with the **HTTP**
tab focused) writes that request alone into the file, rewriting only the lines
it changes and keeping comments and a URL split over several lines, and saves
the file. Other tabs' changes stay unsaved, even in the same file. When the
file has unsaved changes in its editor tab, the request goes into those
instead, and you save the file there. Closing a tab with unsaved changes asks
whether to save them; auto-save doesn't save them. A tab without changes shows
edits made in the editor as you make them; a tab with changes keeps them, and
saving writes them over the file's version. Adding, duplicating, deleting, or
renaming a request from the tool window saves the file, unless its editor tab
has unsaved changes.

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
server streaming method's messages as an array. While a server stream runs,
each message shows as it arrives, with a count, and **Cancel** stops the call. For a client streaming method,
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
  with one is marked **advisory**, and the advisory's title, CVE, and severity
  show under its name; click it to open the advisory.
- Type in the filter to narrow the list by name or description.
- A direct dependency is marked **unused?** when no PHP file in the project
  names its namespace. It may still be used through Laravel's package
  discovery, a helper function, or configuration, so check before you remove
  it. Plugins and command-line tools, such as Pint, aren't checked.
- Click **+** to search Packagist and require a package, as a dependency or a
  dev dependency.
- Click the arrow to run `composer update` for everything, after you confirm.

Commands run in terminal tabs with the Composer that ships with the editor, and
the list reloads when they finish.

## Spell checking

The editor marks misspellings in comments, strings, and names with a green
wavy underline, in PHP, Blade, JavaScript, TypeScript, Vue, Markdown, and more. It
splits names such as `$userAdress` and `get_adress` into words. Press ⌥⏎ on a
misspelling (or use the light bulb, or **Quick Fix** in its hover) to:

- Replace it with the suggestion.
- **Save 'word' to project dictionary**: adds the word to the project's
  `_typos.toml` (or the `typos.toml` or `.typos.toml` it already has), under
  `[default.extend-words]`, keeping the rest of the file. Commit the file so
  the rest of the team skips the word too.
- **Save 'word' to user dictionary**: adds the word to your own dictionary,
  `spelling.toml` in `~/Library/Application Support/ly.almontasser.tusk/`,
  which applies to every project.
- **Don't check spelling in this file**: adds the file to `[files]
  extend-exclude` in the project's typos file.

A saved word takes effect at once, in every open file. **Settings > Spelling**
lists both dictionaries, where you can add and remove words, and sets how
misspellings show (typos, warnings, or errors; warnings and errors count in
the Problems panel) and which file types to check. To turn spell checking off,
clear **Check spelling**.

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
  `$publisher = $this->factory->publisher();`, the editor asks the PHP server for its
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

In Laravel projects (folders with an `artisan` file), the PHP server adds
completion, hover, go to definition, links, and diagnostics for config keys,
routes, views, translations, environment variables, middleware, gates and
policies, container bindings, assets, Vite and Mix files, storage disks,
Inertia pages, validation rules, and Eloquent attributes and relations, in PHP
and Blade files. For example, ⌘-click on `view('welcome')` opens
`resources/views/welcome.blade.php`.

- **Lists of views**, as `View::first([...])`, `view()->first([...])`,
  `@includeFirst([...])`, `@extendsFirst`, and `@componentFirst` take,
  hover, complete, and link each view. Laravel renders the first that exists,
  so missing views are reported only when none of the list exists.
- **Artisan commands**, in a test's `artisan()` and `$this->artisan()`,
  `Artisan::call()` and `queue()`, a command's `$this->call()`, and
  `Schedule::command()`: names complete with their descriptions, and hover
  shows the command's usage and opens its class, or its closure in
  `routes/console.php`. After the name, `--` completes the command's options.
  So do the keys of the parameters array, with its arguments: `['month' =>
  …, '--force' => true]`. A command that doesn't exist, and an option or
  argument it doesn't take, inline or as a key, are reported, so a typo such
  as `messages:archvie` shows in the editor rather than when the test runs.
  The list comes from the booted app, so it includes packages' commands and
  closures, and it's read again when `app/Console`, `routes/console.php`,
  `bootstrap/app.php`, a provider, or `composer.lock` changes.
- **Icons** from the blade-icons sets you install, such as blade-heroicons:
  in `svg('…')`, `@svg('…')`, `<x-heroicon-o-user />` tags, and any string
  that starts with a set's prefix, such as `'heroicon-'`, names complete, and
  the selected one shows its SVG beside the list. Hover shows the icon, and
  ⌘B opens its file. The sets and their prefixes come from the booted app, or
  from the packages' service providers when it can't boot.
- **Eloquent** attributes complete through query chains, such as
  `User::query()->where('`, `$user->posts()->where('`, and a closure passed
  to `whereHas('author', …)`.
- **Gates** match the model you pass: `Gate::allows('update', $post)` links to
  the policy for `$post`'s class, and warns when no policy for it defines the
  ability. A project with a `Gate::before` hook, such as
  spatie/laravel-permission's, gets no warnings for unknown abilities, since
  the hook decides them at run time.
- **Quick fixes** create a missing view (`resources/views/…blade.php`) or
  Inertia page, add a missing variable to `.env` (or the value from
  `.env.example`), and, in `.env` files, add a `VITE_` copy of the selected
  variables. Each opens what it changed.
- **`.env` files** are highlighted: keys, values, comments, `export`, and
  `${VAR}` references. Typing a key completes the keys your other `.env*`
  files assign and those `config/*.php` reads with `env()`, less the ones the
  file already has. The value comes from `.env.example` or the `env()`
  default, never from `.env`, so a secret doesn't land in a committed file.
  ⌘-click a key to see where the project reads it with `env('KEY')`.

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
  pages, open once the PHP server has indexed them. If `route:list` fails, it runs in
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
around them intact; inside `<style>`, echoes and comments do. The PHP server
completes component names after `<x-`. ⌘B on a component tag opens its view,
and for a class-based component also its class in `app/View/Components`.

Mago checks the PHP in Blade files as you type, and the Problems panel's scan
checks every view in `resources/views`: echoes,
`@php` blocks, `<?php` blocks, the arguments of Laravel's directives (`@if`,
`@foreach`, `@include`, `@class`, `@props`, and the rest), and bound attributes
on component tags. It reports syntax errors, and unknown classes, functions,
methods, and constants, and wrong arguments, at their place in the view.
`@use` imports count. A view's variables have the types that the project code
rendering it passes: `view('posts.show', compact('post'))` in a controller types
`$post`, so `{{ $post->titel }}` is reported as an unknown property, and so is
a misspelling on `$comment` inside `@foreach ($post->comments as $comment)`.
`View::make()`, `->view()`, `Route::view()`, `->with()`, and a Livewire
component's or Filament page's public properties count too. A class component's
view gets its public properties and methods: `{{ $isActive }}` calls a method
without parameters, as Laravel does, and `$label('Hi')` is checked against the
method's parameters and return type. A prop passed as `<x-slot:footer>` is a
`ComponentSlot`. When several places
render a view, a variable they all pass gets each place's type; one that some
place doesn't pass, or passes a value of unknown type, isn't checked. The check
doesn't report undefined variables. Custom directives aren't checked.

Laravel's conditionals narrow types the way Laravel compiles them: `@if`,
`@unless`, `@isset`, `@empty`, `@else`, and the rest. So
`{{ $post->author->name }}` reports a possibly null author, but not inside
`@isset($post->author)` or `@if ($post->author)`, and `@break($item === null)`
narrows what comes after it in a loop. Inside `@auth`, and in `@guest`'s
`@else`, `Auth::user()`, `auth()->guard()->user()`, and a `$user` that holds
one aren't null.

The PHP in a view also has hover, completion, and ⌘B, with the same variable
types: `{{ $` lists the view's variables with their types, `{{ $post->` lists
the members of `$post`'s class, hovering `$post->title` shows the property, and
⌘B on it opens the model. Completing a class that the view doesn't import adds
`@use('App\Models\Post')` among the `@use` lines at the view's top, in order,
or after its leading `@props` and `@aware` lines. A namespaced function or
constant gets `@use('function App\helper')` or `@use('const App\LIMIT')`, after
the classes. When the view already has a group for the name's namespace, such as
`@use('App\Models\{Post, User}')`, the name joins it instead. On a Laravel whose
`@use` doesn't read `function`, `const`, or groups, the name is written in full,
`\App\helper()`, and so is a class on a Laravel without `@use`. On an unknown
class name, ⌥⏎ offers **Import class** for each class of that name, with the
same edit.

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
  `PostStatus::Published`. When the options come from the database, as with
  `->options(Category::pluck('name', 'id'))` or
  `->relationship('author', 'name')`, it suggests their keys, such as `5`,
  with each option's label beside it; typing a label, such as `Acme`, finds
  its key.
- **`$get()` and `$set()`.** In `$get('…')`, `$set('…')`, and `Get`'s
  methods such as `$get->string('…')`, it suggests the fields the closure's
  schema reaches, as Filament resolves them: the fields beside it first, then
  the form's other fields with the `../` they need. In a repeater's item,
  `'../../total'` reaches the form's `total`. Each suggestion shows the
  field's type and label. Hover shows the field's code, label, state path, and
  options, and ⌘B goes to its `::make()`. A path that leaves the form, such
  as `'../../../x'` at the top, hovers as a Livewire property. Absolute paths
  start at the Livewire component: `$get('/data.title')` and
  `$get('data.title', isAbsolute: true)` read a resource form's `title` from
  anywhere in the form, and `'/'` completes to `/data.title` and the form's
  other fields.
- **Compared values.** In `$get('status') === '…'`, `match ($get('status'))`,
  and `in_array($get('status'), ['…'])`, it suggests the field's option keys
  or enum values, or the keys of options from the database, such as a user's
  id. On Filament 4, a field with `->options(PostStatus::class)`
  holds a `PostStatus` case, so it suggests `PostStatus::Draft` and the other
  cases instead.
- **Go to declaration.** ⌘B on `'author'` in `->relationship('author')` or
  `'author.name'` opens the model's `author()` method.
- **Warnings.** A relationship name that the model doesn't define is
  underlined as you type. So is a `$get('…')` of a field the schema surely
  doesn't have, such as `$get('total')` in a repeater's item when `total` is
  the form's: the warning suggests `../../total`, or a field with a close
  name, and a quick fix (⌥⏎) writes it. Besides repeaters' items and resource
  forms, this covers an action's modal form that Filament's `Action` or
  `CreateAction` fills with nothing, or any action fills with a literal
  `fillForm([...])`; a Livewire component's own form that its class fills
  only with literal arrays; and a relationship repeater's items at the top of
  a resource's form, which hold the related model's columns too. On Filament 4, comparing an enum
  field's state with a string, as in `$get('status') === 'draft'`, is never
  true, so it's underlined with a quick fix to `PostStatus::Draft`.
- **Icons.** In `->icon('…')`, `->icons([...])`, and the other methods
  whose names end in `Icon`, such as `->prefixIcon()` and `->modalIcon()`,
  in `$navigationIcon`, `FilamentIcon::register()`, an enum's `getIcon()`,
  and the `icon` attributes of `<x-filament::…>` components, icon names
  complete with a preview. Hover over a name or a `Heroicon::OutlinedUser`
  case shows the icon. A name whose set is installed but has no such icon,
  such as `heroicon-o-usr`, is underlined.
- **Colors.** In `->color('…')`, `->colors([...])`, `->badgeColor()`,
  `->iconColor()`, the strings a `->color(fn …)` closure returns, an enum's
  `getColor()`, and `<x-filament::badge color="…">`, color names complete:
  Filament's defaults and the colors your panels and
  `FilamentColor::register()` add. Each name, and each `Color::Amber`, shows
  a swatch of its shade 500. A name Filament doesn't know, such as
  `'secondary'` on Filament 3 and later, is underlined when the app boots.
- **Links between files.** A resource shows links to its model, pages, and
  relation managers above the class. Pages, schemas, tables, and relation
  managers link back to their resource, and a model links to its resources.

Forms and tables in a relation manager or a related records page
(`ManageRelatedRecords`) use the related model. For example,
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

### Run configurations

A run configuration is a named, saved way to run something, as in PhpStorm.
The title bar shows the selected one, with **Run** (⌃R), **Debug** (⌃D),
**Run with Coverage**, and **Stop** (⌘F2) buttons beside it. A green dot on it
means it's running. Click its name to choose another configuration, to add,
edit, save, or delete one, or to open **Edit Configurations…**. ⌃⌥R and ⌃⌥D
pick a configuration in the palette and run or debug it.

The types are:

| Type | Runs |
| --- | --- |
| PHPUnit / Pest | All tests, a directory, a file, a class, a method or Pest test, or a `--filter` pattern, with the runner you choose (detected by default: `php artisan test`, then Pest, then PHPUnit), a configuration file such as `phpunit.xml`, extra options, and coverage on or off |
| Artisan command | `php artisan` with a command and arguments |
| PHP script | `php script.php` with arguments |
| Composer script | A script from `composer.json`, with the bundled Composer |
| npm script | A script from `package.json` |
| Shell command | A command line through `/bin/sh` |
| PHP web server | `php artisan serve`, or PHP's built-in server with a document root, on a host and port |

Every type also has a working directory, environment variables, whether it
runs in Docker when the containers are up (Sail, or the service you chose with
**Choose Docker Service for Commands**), steps to run before launch (another
configuration, or a shell command such as `npm run build`; a step that fails
stops the launch), and **Allow multiple instances**. Without it, running a
configuration that's still running asks to stop it first.

In **Run > Edit Configurations…**, the list on the left groups the
configurations by type. Click **+** to add one from a type's template,
and use the buttons to duplicate or remove the selected one (⌘D and ⌫ in the
list). The form shows each problem, such as a missing test file or a duplicate
name, and the command the configuration runs. **Store in tusk.json (share)**
keeps a configuration in the project's `tusk.json`, so your team gets it when
you commit the file; others stay on this Mac.

Running a test from the gutter, **Run Test at Cursor**, **Run All Tests**, or
Run Anything makes a temporary configuration and selects it, so ⌃R runs it
again. Tusk keeps the five newest; save one from the widget's menu or with
**Save Temporary Configuration**. A running command's terminal tab has a
green icon and a **Stop** button. **Stop** interrupts the command with ⌃C, and
kills it if it's still running 3 seconds later. **Rerun** runs the last run
again; before any run, it asks which configuration to run.

### The Tests tab

While tests run, the **Tests** tab shows progress: a bar, how many tests have
run of how many, how many failed, and a spinner on the test in progress. A
test that fails shows at once, while the rest keep running. This works on
every PHPUnit and Pest version. When the run ends, the header shows the counts
and the total time, and the tree shows every test class and its tests. Classes
with failures start expanded, and the first failure is selected.

- Select a test, with the mouse or ↑ and ↓, to see its output: the failure
  message, **<Click to see difference>** for an assertion that compares two
  values (it opens the expected and actual values side by side), the stack
  frames, which open their file at the line, and anything the test printed.
  Paths inside a container, such as `/var/www/html`, open in the project.
- Double-click a test, or press Enter, to open its source. → and ← expand and
  collapse a class.
- The toolbar has **Rerun**, **Rerun Failed Tests** (a test whose name contains
  a failed test's name doesn't run with them), **Stop**, and toggles to show
  passed tests, show ignored tests, sort by duration, and track the running
  test. **Expand All**, **Collapse All**, **Export Test Results…** (the JUnit
  report), and a filter box follow.

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
code; undo the change and its mark comes back. **Rerun** reruns with coverage too.

The **Coverage** tab in the bottom panel starts with each folder's coverage,
nested, such as `app/Models 45% · 9/20`. Click a folder to list only its
files, and click it again to list them all; click its chevron, or press → and
←, to expand and collapse it. Below, it lists every file with
uncovered lines, least covered first, with each file's percentage. The menu in
the toolbar sorts folders and files by name instead. Under each file, a row shows
a run of uncovered lines, such as `15–17`, and the code on its first line.
Click a row to open it there. The tab follows your edits: its line numbers and
code are the lines as they are now, and lines you changed count as neither
covered nor uncovered, so the summary and each file show how many changed. The
tab's buttons rerun with coverage and hide coverage.

Coverage needs PCOV or Xdebug for PHP. PHPUnit uses PCOV when it's loaded, and
the editor sets `XDEBUG_MODE=coverage` for Xdebug. Only the folders in
`phpunit.xml`'s `<source>` are measured. In Sail, the container's PHP must have
one of them, as Sail's images do when `SAIL_XDEBUG_MODE` includes `coverage`.

In Pest files, `$this` in a test is the test case that `pest()->extend()` or
`uses()` binds to the file's folder with `in()` in `tests/Pest.php`, or that
the file's own `uses()` names. A file nothing binds gets PHPUnit's `TestCase`,
as in Pest. `$this->` completes the test case's methods, and a misspelled one
is reported. A property a test sets on `$this`, such as in `beforeEach()`, has
the type of the value it's given, so `$this->user->` completes the user's
methods. Setting a property the test case doesn't declare isn't reported.
In a helper function in a test file, `test()->user` has the same type.

Tests get the types their values have at runtime:

- `User::factory()->create()` and `make()` are one `User`, not a user or a
  collection of them, unless the chain gives a count with `factory(3)`,
  `count()`, or `times()`.
- In `expect($user)->name->toBe('Ada')`, `->name` is an expectation of the
  user's `$name`, so the chain after it is checked and completes.
- `artisan()` and `$this->artisan()` return a `PendingCommand`, so
  `->assertSuccessful()` and `->expectsOutput()` complete.

Eloquent's forwarded calls have types too, in tests and in your app:
`Post::where('active', true)->first()` is a `Post` or `null`, `Post::count()`
an int, and `$post->where(…)` and `Post::published()`, a scope, an Eloquent
builder of posts, so the chain after them completes and is checked.

Press ⌃⌃ and type an Artisan command with its arguments, such as
`make:model Comment -m`. The command name is matched fuzzily, so `mk:mod`
works. Run configurations match by name too. To run any other command, choose
the last item. What you run becomes a temporary configuration, so ⌃R runs it
again. When `php artisan list` fails, such as when the app can't boot, Run
Anything says so and offers to run it in a terminal to see the whole error.

## Git

The **Commit** tab in the sidebar lists merge conflicts, staged changes, and
unstaged changes, including new files, as a tree. Click a file, or press ⏎, to
see its diff; F4 opens the file. Click a group to collapse it. The folder
button in the header groups files by folder. Select several files with ⌘-click
or ⇧-click, or ⇧↑ and ⇧↓, and ⌘A selects every file. Then act on all of them:
Space stages or unstages, ⌥⌘Z rolls back, and right-click (or ⇧F10) shows every
action. Hover over a file for buttons to open, stage, unstage, or roll it back.
**Rollback** asks first: a staged file goes back to the last commit, an
unstaged one to its staged version, and a new file goes to the Trash.

The message box sits at the bottom of the view, and stays in view while a long
list of changes scrolls. Write a message and press ⌘⏎ or click **Commit**. The
buttons are off while the commit runs, and the status bar shows progress while
git hooks run. If a hook or git refuses the commit, the message offers **Show
Details** with the full output. **Commit and Push** opens the Push dialog after
committing. With nothing staged, **Commit** offers to stage all the changes and
commit them.

If the folder isn't a git repository, the Commit view says so and offers
**Initialize Repository** (also in the **Git** menu). If git isn't installed,
or can't read the folder, it says that instead, with **Try Again**.

### Push, update, and fetch

**Push…** (⌘⇧K) opens the Push dialog: the commits that will go, the remote
and branch to push to, and **Force push (with lease)**, which overwrites the
remote branch unless someone pushed to it since you last fetched. The first
push of a branch sets its upstream branch. Press ⌘⏎ or click **Push**.

**Update Project** (⌘T) pulls the upstream branch, merging by default; the
**Git** settings can make it rebase, or follow git's `pull.rebase`. Local
changes are stashed and restored around it.

Push, update, and fetch run in the background with progress and **Cancel** in
the status bar, and say what happened, such as "Pushed 3 commits to
origin/main." When they can't finish, the message says why and offers the next
step:

- The remote has commits you don't: **Update and Push** updates, then pushes.
- The update stopped for conflicts: **Resolve** opens the merge tool.
- Git couldn't log in, such as after a canceled or wrong password: **Run in
  Terminal** runs the command in a terminal tab.

When git or ssh needs a password, a username, or a key's passphrase, or asks
you to trust a new host's key, Tusk asks in a dialog. The answer goes straight
to git and isn't kept; to save it, use git's credential helper or your SSH
agent.

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

Clicking an annotation shows its commit in a popup: the message, author,
date, and changed files, with **Show in Git Log**, **Show Diff**, and **Copy
Hash**. Click a file in the popup for its diff in that commit. Right-click an
annotation for the same actions.

Press ⌘9 for the **Git Log** in the bottom panel: the commits of the current
branch, with branch and tag labels and a graph of branches and merges. The
header's filters search through git, not just the loaded commits: type in the
search box to find commits by message or hash, choose a branch or **All
branches**, and filter by author or by path. When nothing matches, the log
says so, with **Clear filters**. The log loads 300 commits at a time; **Load
More** at the end loads more. The graph shows when no filter is set.

Use ↑ and ↓ to move through the commits; the details follow the selection.
Press ⏎ for the commit's diff, → to move to its changed files, and ⌘C to copy
its hash. In the details, click a file, or press ⏎ on it, to see its diff
against the previous commit, and move to the commit's other files with the
arrows in the diff's header. From a commit, you can show its diff, copy its
hash, check it out, create a branch at it, cherry-pick it onto the current
branch, or revert it. To see the commits that changed one file, run **Show File
History**, or right-click the file in the tree and choose **Show History**. File
history follows renames.

### Local history

Each time you save a file, the editor keeps a copy of it, outside the project
and outside git. It also keeps one before another program, such as a
`git checkout`, changes a file you have open, and after another program
changes a project file you don't have open, such as a file an Artisan `make:`
command or a formatter rewrites. The first time that happens to a file, the
version git has staged is kept too, so you can go back to it. Refactorings keep
the text before and after, and deleting a file or folder from the tree keeps
it first. Files git ignores, and `.env` files, aren't kept. Versions older than
14 days are deleted, and each file keeps at most 100. Files over 1,000 KB aren't
kept. **Settings > Local History** changes all three.

To see a file's history, choose **File › Local History › Show Local History**,
right-click the file's tab or the file in the tree, or run it from ⌘⇧A. For a
folder, right-click it in the tree; **Show Project Local History** covers the
whole project, deleted files included. The **Local History** tab opens in the
bottom panel:

- The left side lists the versions, newest first, with the time and what kept
  each one: **Saved**, **External change**, a git command such as
  **Before git checkout**, **Before refactoring** and **Refactoring**,
  **Before delete**, or **Before revert**. A folder's list also shows each
  file, marks deleted files, and has a filter.
- The right side compares the selected version with the file as it is now,
  including unsaved edits. To compare two versions, press Space or ⌘-click one
  to mark it, then select the other.
- **Revert** (⌘⌫ in the list) sets the file back to the selected version,
  after asking. The current text is kept as a version first, and **Undo** in
  the message puts it back. With the file open, ⌘Z in the editor undoes it
  too.
- **Put Label…** (also in the File menu and ⌘⇧A) names the current moment for
  the whole project, such as "Before the upgrade". Labels show among the
  versions; select one and click **Revert** to set the file, or in a folder's
  history every file under it, back to how it was then.
- ↑ and ↓ move through the list, Enter opens the file, and typing jumps to a
  version by what kept it (in a folder, by path).

To get back a deleted file, run **Local History: Deleted Files…** from ⌘⇧A and
choose the file, or find it in a folder's history, then **Revert** to a
version. Its folder is recreated if needed.

### Interactive rebase

To rewrite recent commits, open a commit in the Git Log and choose
**Interactive Rebase from Here…**, or run **Interactive Rebase…** from ⌘⇧A and
choose the commit to rebase onto. The commits after it are listed, oldest
first. For each, choose **Pick**, **Reword** (and edit its message), **Edit**
(stop at it to change its files), **Squash into previous**, **Fixup** (squash
and discard its message), or **Drop**. Reorder them by dragging, with the
arrows, or with ⌥↑ and ⌥↓. As in git's own list, P, R, E, S, F, and D set the
selected commit's action.
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

Run **Stash Changes…** (from ⌘⇧A, the **Git** menu, or the **+** in the
**Stashes** tab) to set your uncommitted changes aside. The dialog takes an
optional message, and has two options: **Keep staged changes** leaves what you
staged in place, and **Include untracked files** stashes new files too.

The **Stashes** tab of the Commit tool window (or **Stashes…** from ⌘⇧A) lists
your stashes, newest first, with the branch each was made on and its age.
Click a stash, or press →, to list its changed files, and click a file, or
press ⏎, to see its diff. ⏎ on a stash opens the whole stash's diff: move
between its files with the arrows in the diff's header, or ⌥⌘← and ⌥⌘→.
Hover over a stash for **Apply** (keep the stash), **Pop** (apply, then drop
it), and **Drop**, or right-click it for these plus **Unstash as New
Branch…**, which checks out a new branch at the commit the stash was made on
and pops the stash there. Press ⌫ to drop the selected stash; dropping asks
first. If a stash applies with conflicts, it's kept, and the message offers
the merge tool.

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
space, so the lines all three share stay side by side. The panes scroll
together.

The header counts the conflicts left and marks the one at the cursor. Move
between conflicts with the arrows or F7 and ⇧F7. **Accept Left** (⌥⇧←),
**Accept Right** (⌥⇧→), and **Accept Both** resolve the conflict at the cursor
and move to the next. **Apply Non-Conflicting Changes** merges every conflict
whose two sides changed different lines, even neighboring ones, and says how
many are left for you. The **⋯** menu has **Accept All Yours** and **Accept All
Theirs**. **Mark Resolved** saves and stages the file when no conflicts are
left, then opens the next conflicted file. When several files conflict, a list
on the left shows each one, with a check mark once it's resolved.

If one side deleted the file and the other changed it, the pane titles say
which, and a bar offers **Keep File** or **Delete File**.

The same links appear when a conflicted file is open in a tab, and saving it
with no conflicts left also marks it resolved.
For a merge, the commit message is filled in, so you can click **Commit** to
finish.

### Branches

The branch name in the title bar, and again at the right of the status bar,
shows commits ahead (↑) and behind (↓) the upstream branch. Click either, or
run **Branches…** from ⌘⇧A, for the branches popup. Type to search. At the top
are **Update Project…**, **Commit…**, **Push…**, **Fetch**, **New Branch…**,
**Checkout Tag or Revision…**, the stash actions, and **Worktrees…**. Below them
are the local branches, current first, then the remote branches, each with its
ahead and behind counts, its upstream branch, and the age of its last commit.
Type a name that isn't a branch to create it.

Choose a branch for its actions. Press a number to pick one:

- **Checkout.** A remote branch gets a local branch that tracks it. If your
  changes would be overwritten, the message offers **Smart Checkout**, which
  stashes them, checks out, and brings them back.
- **New Branch from…** creates a branch at that branch and checks it out.
- **Checkout and Rebase onto** the current branch.
- **Compare with** the current branch lists the commits on either side in the
  Git Log. **Show Diff with** the current branch lists the files that differ,
  as a diff you can step through.
- **Rebase** the current branch onto it, or **Merge** it into the current
  branch. If that stops for conflicts, the message offers the merge tool.
- **Push…**, **Rename…**, **Set Upstream Branch…** (or **Track Another
  Branch…**), and **Stop Tracking**.
- **Delete…**. A branch with commits that aren't merged asks before a force
  delete, and the message after deleting offers **Restore**. Deleting a remote
  branch deletes it on the remote, after asking.

**Fetch** (the popup, the **Git** menu, or the Commit view's header) fetches
every remote, prunes branches deleted there, and says how many branches
changed. Long operations show progress in the status bar, with **Cancel** for
the ones that talk to a remote.

## Pull requests

The **Pull Requests** tab lists the repository's pull requests through the
GitHub CLI. Filter by open pull requests, ones you created, or ones waiting for
your review, and type in the search box to search them with GitHub's search
syntax, such as `fix label:bug`. Each row shows check status (✓ passed, ✗
failed, ● running) and the review decision. The list shows 50 at a time;
**Load More** at the end shows 50 more. If the GitHub CLI isn't installed, or
you aren't logged in, the tab says so and offers to fix it.

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
debugging on for the processes it starts. Herd's PHP loads Xdebug only under
`herd debug` and `herd coverage`, so the editor's debug, coverage, and profiled
runs load Herd's copy themselves.

1. Click the gutter to the left of a line number, or press ⌘F8, to set a
   breakpoint. Breakpoints are saved with the project.
2. Start a debug session in one of these ways:
   - Click **Debug** above a test, or press ⌃⇧D in a test. The test runs with
     Xdebug on.
   - Run **Start Debug Server** from ⌘⇧A. It runs `php artisan serve` with
     Xdebug on, so every page you open in the browser stops at your breakpoints.
   - For another setup, such as Herd or Valet, run **Start Listening for PHP
     Debug Connections**, then start a request with Xdebug's trigger (the
     `XDEBUG_SESSION` cookie, which browser extensions set, or
     `XDEBUG_TRIGGER=1` in the URL) and `xdebug.mode=debug` in your PHP
     configuration.

   The Debug tab says what the debugger is doing: not listening, listening on
   a port and waiting for PHP (with these ways to connect), running, or paused
   at a file and line.
3. When execution stops, the **Debug** tab in the bottom panel shows the call
   stack and variables, and the editor shows the values of the variables on
   the lines above the paused one at the ends of those lines. Click a frame, or
   use ↑ and ↓ in the call stack, to see its variables. In the variables, ↑ ↓
   move, → and ← expand and collapse objects and arrays, F2 changes a value,
   and ⌘C copies it. Right-click a variable for **Copy Value**, **Copy Name**,
   **Add to Watches**, and **Set Value…**. To change a value, type a PHP
   expression, such as `'text'` (with quotes), `42`, or `null`, and press
   Enter.
   Type an expression, such as `$request->all()`, in the field at the bottom
   to evaluate it: ↑ and ↓ go through earlier expressions, and typing `$`
   suggests the names in the frame's scopes (Tab or Enter completes one).
   Use F9 to resume, F8 to step over, F7 to step into, ⇧F8 to step out, and ⌘F2
   to stop.

If another program already listens on the port, such as another editor's
debugger, the Debug tab names it and offers **Choose Another Port**. The port
and the other debugger options are in **Settings** under Debugger (the gear in
the Debug tab). Runs the editor starts use the port you choose; for PHP you
start yourself, set `xdebug.client_port` to match.

### The Breakpoints tab

Press ⇧⌘F8, click the breakpoint button in the Debug tab, or run **View
Breakpoints…** to open the **Breakpoints** tab in the bottom panel. It lists
line breakpoints by file, with each line's code, and the exception
breakpoints. Changes you make in the gutter show there at once.

- Select a breakpoint to edit it on the right: turn it on or off, and set its
  condition, hit count, or log message. Each field applies when you press
  Enter or leave it.
- Use ↑ ↓ to move, → ← to expand and collapse files, Space to turn the selected
  breakpoint (or file's breakpoints) on or off, Enter or F4 to go to its line,
  and Delete to remove it. Select a file to turn all its breakpoints on or off
  or remove them.
- **Remove all breakpoints** (in the toolbar) asks first.
- Select **Pause on exceptions** for the exception options described below.

### Breakpoint options, watches, and exceptions

Right-click the gutter at a line to add, remove, disable, or edit its
breakpoint, add a conditional breakpoint or a logpoint, remove the file's or
all breakpoints, annotate the file with Git blame, or copy the line's
reference (`path:line`) or its link on the remote, such as GitHub, at the
current commit. **Copy Remote URL** in ⌘⇧A
copies the link to the selected lines. While execution is paused, **Run to Line** resumes
and pauses at that line once. Run **Edit Breakpoint…** from ⌘⇧A to edit the
breakpoint at the cursor in the palette, or press ⇧⌘F8 to edit it in the
Breakpoints tab:

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
shows the exception's class and message. To narrow it, click the arrow next to
the icon, or run **Pause on Exceptions Options…** from ⌘⇧A. Both open the
Breakpoints tab at its exception breakpoints:

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
`XDEBUG_MODE=debug` and points it at the Debugger setting **Host that PHP in
Docker connects to** (`host.docker.internal` by default) and the debugger's
port.

## Profiling

The editor runs Xdebug's profiler and shows the result in the **Profiler** tab
of the bottom panel. Run these from ⌘⇧A:

- **Profile Test at Cursor**, or the **Profile** link above a test, runs the
  test with the profiler and opens its profile when the run ends.
- **Profile URL…** asks for a path, such as `/posts?page=2`, requests it
  through the profiling server (starting the server if needed), and opens that
  request's profile. The status bar shows the response code and time. While
  it waits for the server to start or for Xdebug to finish the profile,
  **Cancel** in the status bar stops waiting.
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
and → and ← open and close a node. Click a column heading to order each node's
callees by time, calls, or name.

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
and time. Click a column heading to sort by SQL, runs, or time. The side pane
lists a query's first 200 runs, and a function's 100 slowest callers and
callees, and says when there are more. While another profile loads, the open
one dims. Two flags point at common problems:

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
anything missing. SQLite, MySQL, MariaDB, PostgreSQL, and Redis work without
installing a client, because the drivers are built into the app.

To use another database, click the connection line under the tool window's
title, or run **Database: Switch Connection…** from ⌘⇧A. The list shows `.env`'s
connection, the ones you saved, and the other connections in the app's
`config/database.php`, such as a read replica, and the app's Redis
connections from `.env`: **redis** (`REDIS_DB`) and **redis cache**
(`REDIS_CACHE_DB`, database 1 unless set), where Laravel's cache store keeps
its values.

### Data Sources

Click the gear in the tool window, or run **Database: Data Sources…**, to
manage connections. The dialog lists them on the left and shows the selected
one's settings on the right:

- **Driver**, then a **Database file** for SQLite, or **Host**, **Port**,
  **User**, **Password**, and **Database** for the others (**Database number**
  for Redis).
- **SSL mode** (`disable`, `prefer`, `require`, `verify-ca`, or
  `verify-full`, as in PostgreSQL) and a **CA file**.
- **SSH tunnel**: the SSH host, port, and user, and a **Key file**. Leave the key
  file empty to use your SSH agent and `~/.ssh/config`. The editor opens the
  tunnel with your Mac's `ssh`, which can't ask for a password, and the host and
  port above are then as the server sees them, such as `127.0.0.1:3306`.
- **Read-only**: SQLite opens the file read-only, MySQL and PostgreSQL start a
  read-only session, and the console and grid refuse changes.
- **URL**, kept in step with the fields. Paste a URL, such as
  `mysql://forge:secret@203.0.113.5:3306/laravel`,
  `pgsql://user@host/app?sslmode=require`, `sqlite:database/other.sqlite`, or
  `redis://:secret@203.0.113.5:6379/0` (`rediss://` for TLS), to fill in the
  fields.

Click **Test Connection** to connect, through the tunnel when there is one,
and see the server's version or why it failed. **+** adds a connection, the
copy button duplicates one, and **−** removes a saved one. Nothing changes until
you click **Save**.

Passwords go to your system's password store (the Keychain on a Mac, Credential Manager on Windows, the Secret Service on Linux), never to the project; leave the password
empty to keep the saved one. `.env`'s connection shows its values read-only.
Click **Override on This Mac** to change them for yourself (the project's
`.env` stays as it is), and **Use .env's Values** to go back. The SSH tunnel and
read-only mode apply to any connection, including `.env`'s. Check **Share saved
connections in tusk.json** to share them with the project, without passwords.

TLS for `.env`'s connection follows the same settings as Laravel's
`config/database.php`: `DB_SSLMODE`, and `MYSQL_ATTR_SSL_CA` or
`DB_SSLROOTCERT` for the certificate authority. PostgreSQL defaults to
`prefer`. `require` encrypts without checking the server's certificate, and
`verify-full` checks it and the host name.

**Database: Connect over SSH…** opens Data Sources on the selected connection's
tunnel. When a connection fails, the tool window and the results show why, with
**Retry** and **Edit Connection…**.

### Tables

- Type in **Search tables and columns** to list only the tables whose names, or
  whose columns' names, contain it. A table that matches by a column shows the
  column's name.
- Click a table, or press →, to see its columns, then its indexes and foreign
  keys. A `?` after a type marks a nullable column. ↑↓, Home, End, Page Up,
  Page Down, and typing a name move through the tree.
- Double-click a table, or press Enter, to show its rows. Double-click a foreign
  key to open the table it references.
- Right-click a table to open it, copy its name, or write a `SELECT` or `INSERT`
  with its columns at the end of the query console (**Database: Generate
  SELECT** and **Database: Generate INSERT**). ⌘C copies the selected name.

### Queries

Press ⌘⇧F10 (**Open Query Console**) to open the project's console, then press
⌘⏎ to run the statement under the caret, or each statement in the selection.
**Execute All Statements** runs every statement in the file. ⌘⏎ also runs SQL in
any `.sql` file. Statements split at semicolons outside strings, comments, and
PostgreSQL's `$$` quotes.

- Several statements show a tab each, and run one after another until one
  fails. A tab's icon shows whether its statement ran.
- While a statement runs, the results show the time so far and **Cancel**, which
  stops it in the database: SQLite interrupts it, MySQL and MariaDB run
  `KILL QUERY`, and PostgreSQL cancels it. **Database: Cancel Query** does the
  same. With a **Query timeout** in Settings, a longer query is canceled for
  you.
- When it's done, the results show the rows and the time it took.
- **Database: Query History…** lists the statements you ran in this project,
  newest first, with when, where, and how they went. Choose one to add it to the
  console.
- SQL completion suggests your tables and columns. After `name.`, it suggests
  the columns of that table, or of the table that `name` is an alias for.

### The results grid

- Results come a page at a time (1,000 rows unless you change **Rows per page**
  in Settings). **Next** and **Previous** page through them, and the summary shows
  which rows you see, and how many there are.
- Click a column's header to sort by it, then again for descending, and a third
  time to stop sorting. A table sorts in the database with `ORDER BY`; other
  results sort in the grid.
- A table has **WHERE** and **ORDER BY** fields above its rows. Type a
  condition, such as `id > 10 AND name LIKE 'a%'`, and press Enter.
- Drag a header's right edge to resize a column; double-click it to fit.
- Move with the arrow keys, Tab, Home, End, Page Up, and Page Down (⌘ with an
  arrow goes to the edge). ⇧ with a move, or a drag, selects cells, and ⌘A
  selects all. ⌘C copies the selected cells as tab-separated values.
- Right-click for **Copy As** CSV, TSV with a header, JSON, SQL `INSERT`, or
  Markdown, and **Export…**, which saves every row of the query or table to a
  file in one of those formats.
- ⇧⏎ or **Value** opens the value viewer beside the grid: long text in full,
  JSON indented, and binary values as hex. Edit a value there to change the
  cell. NULL shows in italics.
- Press Enter, F2, or double-click to edit a cell, or start typing. Enter keeps
  the change, Tab keeps it and moves on, and Escape cancels. Type `NULL` for a
  null value, or press ⌥⌘N (**Set NULL**); ⌥⌘D (**Set Default**) sets the
  column's default. Tables without a primary key, binary values, and read-only
  connections can't be edited.
- **Add Row** adds a row at the top; cells you leave get the column's default.
  ⌘⌫ (**Delete Rows**) marks the selected rows for deletion.
- Changes wait, marked in the grid (yellow for edited cells, green for new
  rows, and struck through for deleted ones), until you click **Submit** or
  press ⌘⏎. They apply together, in one transaction: if one fails, none do.
  Hover over **Submit** to see the SQL. **Revert** drops them. Before anything
  replaces a grid with pending changes, such as another query or another page,
  the editor asks.

Results show in the **Database** tab of the bottom panel. After you change
`.env`, click **Refresh** in the tool window.

### Redis

With a Redis connection selected, the tool window lists keys instead of
tables, in folders by `:`, as `cache:users:1` goes in **cache** then **users**.
Each key has a badge for its type: STR, HASH, LIST, SET, ZSET, STRM (stream),
or JSON (RedisJSON). Keys load 500 at a time with `SCAN`, which doesn't block
the server; click **Load More** at the bottom for the next batch, which also
shows how many keys the database has.

- Type in the filter box to show keys that contain the text, or type a
  pattern such as `laravel_cache:*` or `user:?`. Press Escape to clear it.
- Click a key, or select it and press Enter, to see its value in the
  **Database** tab. ↑↓, Home, End, Page Up, and Page Down move through the
  tree, → and ← open and close folders, and typing a name jumps to it.
- Right-click a key to copy its name, rename it, set when it expires, or
  delete it. Right-click a folder to show only its keys, copy its pattern, add
  a key in it, or delete every key in it (all of them, not only those loaded,
  after telling you how many). The status bar shows the count and the deletion
  as they go, with **Cancel**; canceling keeps what's deleted so far. ⌘⌫ deletes
  the selected key or folder.
- A key whose name isn't text can't be typed into a command, so it isn't
  listed; the tree says how many it skipped.
- Click **+** (**Add Key…**) to create a key: choose its type, then type its
  name and first value.

The key's header shows its type, size, memory use, and time to live, which
counts down. Click the time to live to change it; leave it empty for no expiry.

- A string opens in an editor. JSON values are marked and highlighted, and
  **Format JSON** indents one. Values from PHP's `serialize()`, which Laravel's
  cache and sessions use, are marked. Press ⌘S or click **Save** to write the
  value back; its expiry stays. A value that isn't text, such as a compressed
  cache entry, shows as hex and is read-only.
- A hash, list, set, sorted set, or stream shows in the grid, 1,000 rows at a
  time, with **Next** and **Previous**. A list's rows are numbered by their
  Redis index, from 0. Edit, add, and delete rows as in a table; **Submit**
  applies the changes in one transaction. A stream's entries can only be
  deleted.

⌘⇧F10 opens a Redis console, where ⌘⏎ runs the command on the caret's line,
such as `TTL laravel_cache:greeting`, or each line of the selection, with a
row per command. Quote an argument that has spaces, as in `redis-cli`.
Completion suggests commands, with their syntax, and keys; hover over a command
to see what it does. `SCAN` follows its cursor to the end, so
`SCAN 0 MATCH laravel_cache:*` lists every matching key. Commands that affect
the whole database or server, such as `FLUSHDB`, ask first. Lines starting
with `#` are comments.

## Deployment

Tusk uploads the project to servers over SFTP, FTP, or FTPS, as PhpStorm's
Deployment does. The connections are built into the app, so there's nothing
to install.

### Servers

Run **Deployment: Settings…** from ⌘⇧A, or choose **Deployment > Deployment
Settings…** in the Project tree's context menu. The dialog lists the servers on
the left and shows the selected one's settings on the right:

- **Type**: SFTP, FTP, FTPS with explicit TLS (`AUTH TLS`, on port 21), or FTPS
  with implicit TLS (port 990). **Host**, **Port**, and **User**.
- For SFTP, **Log in with**: your **SSH agent**, a **Key pair** (a key file, or
  `~/.ssh/id_ed25519`, `id_ecdsa`, and `id_rsa` when you leave it empty, with
  its passphrase if it has one), or a **Password**. Key files can be OpenSSH,
  PEM, or PuTTY `.ppk` keys (versions 2 and 3).
- An SFTP **Host** can be a `Host` alias from `~/.ssh/config`, which the field
  suggests. The alias connects as `ssh` would: to its `HostName`, `Port`, and
  `User`, with its `IdentityFile` keys, through its `ProxyJump` hosts or its
  `ProxyCommand` (run with `sh`, such as `cloudflared access ssh --hostname
  %h`), with its key kept under its `HostKeyAlias` in `known_hosts`. `Match`
  blocks apply as in `ssh`, `Match final` included, except `Match exec`, whose
  command Tusk doesn't run: when one may apply, a warning under the field says
  so. Under the field, Tusk shows what the alias connects to. A user, port, or
  key file you type here wins over the file's.
- A jump host logs in with your SSH agent, then its key files. When it asks for
  a password, or its key has a passphrase, Tusk asks for it, naming the jump
  host, and saves it in the system's password store for that user and host, so
  every server through it uses it. A refused one asks again.
- For FTP and FTPS, a **Password** (empty with no user logs in anonymously),
  **Passive mode** (on by default, for firewalls and NAT), and for FTPS, **Don't
  check the server's certificate**, for a self-signed one.
- **Root path**: the folder on the server that mappings are relative to, such
  as `/var/www/shop`. **Detect** fills in the folder you log in to.
- **Web URL**: the site's address, such as `https://staging.example.com`, for
  **Open on … in the Browser**. Files in `public/` open at the site's root.
- **Mappings**: which project folder goes where on the server. The default maps
  the whole project to the root path. A server path that starts with `/` is
  absolute; one that doesn't is inside the root path. The resolved path shows
  under each one.
- **Delete files from the server when you delete them in the project**: off
  by default. While saved files upload to this server as the default, deleting
  a file or folder in the project deletes the server's copy, and a moved or
  renamed file uploads under its new name. More than 20 deletions at once, as
  from a branch switch, ask first with a list. Files deleted while Tusk was
  closed are listed in one confirmation when the project opens: Tusk keeps a
  record of the files it uploaded, downloaded, or found the same on both sides
  in Sync with Deployed, and asks about those that are gone. **Delete from
  staging** deletes them, and the server's folders they leave empty, when
  those are gone from the project too; **Keep on Server** forgets them, so
  Tusk doesn't ask again. Excluded paths and a mapping's own folder are never
  deleted.
- **Excluded paths**, one per line, are never uploaded or downloaded. A name,
  such as `node_modules` or `*.log`, matches at any depth, as in `.gitignore`;
  a path with `/`, such as `storage/logs`, matches from the mapping's folder.
  New servers leave out `.git`, `.idea`, `.vscode`, `.DS_Store`,
  `node_modules`, `.env`, `storage`, and `bootstrap/cache`; click a suggestion,
  such as `vendor`, to add it.

Click **Test Connection** to log in and see how long it took, or why it
failed: a wrong host, a refused password or key, a timeout, an untrusted
certificate, or a root path that doesn't exist. The first time Tusk connects
to an SFTP server, it shows the server's key fingerprint and asks whether to
trust it, then adds it to `~/.ssh/known_hosts`, as `ssh` does. A server whose
key changed since is refused with a warning, and **Replace the Key and
Connect** replaces the old entry.

The star marks the **default server**, which Upload, Download, Sync, and
uploads on save use. **Upload saved files to the default server** uploads each
saved file that a mapping covers: **Never**, **On explicit save (⌘S)**, or **On
every save**, auto-save included. Check **Share servers in tusk.json** to
share them with the project. Passwords and passphrases go to the system's
password store, never to the project.

### Uploading and downloading

Right-click a file or folder in the Project tree, or in the editor, and choose
**Deployment**:

| Action | What it does |
| --- | --- |
| **Upload to staging** (⌥⇧⌘X) | Uploads the file, or every file in the folder that isn't excluded, to the default server |
| **Upload to…** | Asks for the server first |
| **Download from staging**, **Download from…** | Replaces the local copy with the server's, or downloads the folder's files |
| **Sync with Deployed to staging…** | Compares the file or folder with the server's, see below |
| **Compare with Deployed Version on staging** | Shows the server's copy and yours in the diff view, with **Upload to staging** |
| **Delete from staging…** | Deletes the server's copy of the file or folder, after listing what goes. The project keeps its own |
| **Open on staging in the Browser** | Opens the file's page on the server's web URL |

⌘⇧A has the same actions for the open file, and **Deployment: Upload Project
to…** and **Deployment: Sync Project with Deployed…** for the whole project.

Transfers run in the background, up to four files at a time on an SFTP server
and two on an FTP server. The status bar shows how many are left and their
progress; click it, or run **Deployment: File Transfer**, to see every file
with its progress, size, and state, and to cancel one or all of them. A file
replaces the server's copy only once it's complete: Tusk uploads it under a
temporary name beside it and renames it into place, keeping the old file's
permissions (and on SFTP its group, and its owner where the server allows) and
the local file's modification time. A dropped connection is
retried twice on its own. Other failures, such as a permission the server
refuses, show in a notification with **Retry** and **Show Transfers**. A
download asks first when it would replace unsaved changes in an open file.

### Sync with Deployed

**Sync with Deployed** opens a tab that lists the files that differ between
the project and the server: changed files, files only in the project, and files
only on the server. Each row shows both copies' sizes and times, with a dot on
the newer one. Files whose sizes match but times differ are read on both sides
and compared, so a file another tool uploaded doesn't show as changed.

Each row has an action: **←** downloads, **–** skips, **→** uploads, and for a
file on one side only, the trash deletes it there: from the server, or from
the project to the Trash, where Local History keeps it too. By default, Tusk
uploads what's newer in the project, downloads what's newer on the server, and
skips files that are only on the server, such as uploads and logs; it never
deletes unless you choose it. In the list, ← and → change the selected row's
action, Space skips it, ⌦ deletes it, and ⏎ opens it in the diff view. **Set
all** changes every row. **Synchronize** lists the files it will delete and
asks first, runs the transfers and deletions, then compares again.

### Remote Host

The **Remote Host** tool window (the remote explorer icon) shows the default
server's files as a tree, starting at the root path. Click the server line to
browse another server.

- Double-click a file to open it in the editor. Saving it uploads it back.
  When the server's copy changes, such as when a teammate uploads it, the file
  reloads when you come back to Tusk. With unsaved changes, a bar above the
  editor asks instead: **Compare** shows both, **Keep Mine** lets your next
  save replace the server's, and **Load Server's** replaces your changes,
  which ⌘Z brings back. A file deleted on the server gets a bar with
  **Upload to staging**.
- Drag files or folders from the Project tree onto a folder to upload them
  there.
- Right-click for **Download to** (the project file a mapping matches),
  **Compare with Local Version**, **Sync with Local Folder…**, **New Folder…**,
  **New File…**, **Rename…** (⇧F6), **Delete…** (⌦, which asks first), **Copy
  Path**, **Open in the Browser**, and **Copy URL**.

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
`path:line:column severity rule message`; on a file, ⌘C copies all its
problems, one per line. Right-click a problem to copy it or its message, or to
show its details. Right-click a file to copy all its problems or only their
messages.
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
the code around the problem, and **Go to Code**. When Mago shows how two types
differ as a diff, the popup and the page show it as a colored diff. The page opens as an editor
tab, and Escape closes it. For a Mago lint problem, the page
also shows Mago's explanation of the rule under **About this rule**.

To see the cursor line's worst problem at the end of the line, as the Error Lens
extension does, turn on **Show the cursor line's problem at the end of the
line** in Settings, or run **Toggle Inline Problems** from ⌘⇧A. Long messages
are cut short, and `+2` counts the line's other problems. The message hides
while you type and comes back when you pause.

The first time you open the Problems panel, it scans the project: the PHP
server runs the checks it runs for open files (Mago's analyzer and linter, and
its own, such as unused imports) over every project PHP file at once, in a few
seconds. The status bar and the panel count the files checked so far, and
**Cancel** in the status bar stops the check. **Scan Project** rechecks every file, since a change in one file can
change another's problems. Open files show their live problems as you type.
Mago's notes and help show in the editor only, not in the panel. The status bar
counts cover the project once it has been scanned. Laravel's, Filament's, and
Tailwind's problems show for open files only.

When `composer.lock` or `mago.toml` changes, for example after `composer
require`, the PHP server indexes the project again, so new packages' classes
and functions are found.
This also happens when you open a project whose `composer.lock` changed while
the editor was closed. To do it yourself, run **Reindex Project** from ⌘⇧A.
PHP files that other programs create or change, such as `php artisan make:model`
or a `git checkout`, are indexed a few seconds later.

**Index exclusions** make indexing and Mago's checks faster by skipping vendor
folders whose PHP files declare no classes or functions, such as AWS's API data
and packages' translations. On a Laravel and Filament app, the default list
takes a full index from 116 to 94 seconds. To change the list, run **Index
Exclusions…** from ⌘⇧A:

- **Scan vendor** lists the vendor folders of 100 KB or more where no PHP
  file declares anything, with their file counts and sizes. Checked folders are
  skipped when you save.
- Add a folder by path, such as `vendor/package/data`. `*` matches within a
  folder name and `**` matches any number of folders, as in
  `vendor/**/resources/lang`. **Restore Defaults** puts back the starting list.
- **Share with the project in tusk.json** saves the list in the project's
  `tusk.json`, as `"indexExclude": [...]`, so your team can commit it.
  Otherwise, the list is kept on this Mac only. See [Project settings and
  tusk.json](#project-settings-and-tusk-json).

You can also right-click a folder in the Project tree and choose **Exclude
from Index** or **Include in Index**. When you open a project for the first
time, and whenever `composer.lock` changes, the editor scans `vendor` in the
background. If it finds folders to skip that it hasn't suggested before, such
as a new package's data, a hint in the corner offers **Review**, which opens
the dialog with the scan's suggestions. Saving a changed list rebuilds the
index from the start. When the project has its own `mago.toml`, Mago uses that
file's `excludes` instead.

**Formatting** (⌥⌘L) uses your project's own tools:

1. **Prettier**, for every file its configuration can parse: the project's own
   when it has one in `node_modules`, and otherwise the bundled Prettier, which
   formats JavaScript, TypeScript, CSS, SCSS, Less, JSON, HTML, Markdown, YAML,
   Vue, Svelte, and Astro. With `@prettier/plugin-php` or a Blade plugin in
   the project, the project's Prettier formats PHP and Blade files too.
2. **Laravel Pint**, for PHP files Prettier doesn't handle, when the project has
   `vendor/bin/pint`.
3. **Mago's formatter**, the fallback for PHP, built into the PHP server.

That order is **Auto**. To choose a formatter per language, run **Code >
Formatters…**. For PHP, Blade, JavaScript, TypeScript, and Vue, CSS, JSON,
Markdown, and YAML, choose Auto, a specific formatter (Laravel Pint, PHP CS
Fixer, Mago, Prettier, blade-formatter, or Monaco's built-in one, where they
apply), or **None**. Each language also has an **On save** choice that turns
format on save on or off for it; **Default** follows **Format files when
saving**. The choices are a project setting, which you can share in
`tusk.json`, since teams standardize their formatters.

- After formatting, the status bar names the formatter that ran, such as
  "Formatted with Laravel Pint".
- When the chosen formatter isn't installed, Tusk says how to install it, such
  as `composer require laravel/pint --dev`, with a **Formatters…** button.
- PHP CS Fixer formats a copy of the file in the temporary folder with the
  project's configuration, since it doesn't read standard input.

Prettier, including the bundled one, and Pint read the project's own
configuration files, and Prettier follows `.editorconfig`. Mago reads the
`[formatter]` section of `mago.toml`: a `preset` (`default`, `psr-12`, `pint`,
`tempest`, `hack`, or `drupal`), options over it, and `excludes`. A file with
a syntax error isn't formatted; the status bar names the line.

Mago checks PHP files as you type (static analysis and lint).
If your project has a `mago.toml` file, Mago uses it. Otherwise the app uses
defaults tuned for Laravel, in `src-tauri/resources/mago.toml`: the analyzer
reads the project and `vendor` but skips hidden folders, `node_modules`, and
`storage`, rules that flag normal Laravel code (`strict-types`,
`literal-named-argument`, and `prefer-first-class-callable`, since Filament
fills closure parameters by name) are off, rules about code size and
complexity (such as `cyclomatic-complexity`, `halstead`, and
`too-many-methods`) and matters of taste (such as `prefer-static-closure` and
`no-else-clause`) are off, the remaining style rules show as warnings rather
than errors, and tests, factories, and seeders may
set literal passwords. Mago checks against the lowest PHP version your
`composer.json` allows. Mago's analyzer doesn't know Laravel's
magic, such as Eloquent attributes and relationships (`$post->author`),
forwarded calls (`Post::create()`), or request input (`$request->email`). The
editor reads your models' columns, relationships, accessors, and scopes, and
hides those reports, and the ones they cause further on, when Laravel really
has the member; anything left shows as a hint (dots you can hover), not as a
problem. Laravel's root aliases, such as `use DB;`, resolve too: the editor
writes stubs for them that the PHP server and Mago read. It also gives Mago corrected
copies of the Laravel and Pest files whose types are wider than what your code
gets back, as Larastan does: `__()` returns a string, `auth()->user()` your
user model, and `shouldReceive()` takes arguments. Without those copies, as in
a project with its own `mago.toml`, `auth()` still has the default guard's
methods, such as `user()`, `id()`, `check()`, and `login()`, in problems,
completion, and hover, and `auth()->user()` returns what `Auth::user()` does.
A Pest test's `$this` is
the test case `tests/Pest.php` binds to its folder. Problems Mago can't prove, such as a value that may be null, show
as warnings; using a value of unknown type shows as a hint.

⌥⏎ on a Mago problem offers Mago's own fix, such as removing an unused import,
and **Fix All Safe Mago Problems in File**. A fix that may change what the
code does says so in its title. **Fix All Safe Problems in File** in ⌘⇧A
applies the safe fixes without the menu. **Suppress *rule* for this line**
adds a `// @mago-expect lint:rule` comment (`analysis:` for the analyzer)
above the line, or adds the rule to one already there. Mago reports the
comment once the problem is gone, and its fix removes the comment.
⌥⏎ on a linter problem also offers **Disable *rule* in mago.toml** and
**Change *rule*'s level…**, and on an analyzer problem **Ignore *code* in
mago.toml**.

### PHP analysis settings

**Tools > PHP Analysis Settings…** opens **Settings > PHP Analysis** for the
open project:

- **Index every library file in full**: off by default, the PHP server reads
  the vendor code your project reaches in full and the rest by name only. On,
  it reads all of `vendor` in full, for complete types everywhere, at several
  times the memory.
- **Extra stub folders**: folders or PHP files, relative to the project or
  absolute, that the index reads as library code, such as stubs for a PHP
  extension.
- **PHP version**: the version Mago checks against, from `composer.json` or
  one you choose (`php-version` in `mago.toml`).
- The analyzer's switches, such as reporting unused parameters or missing
  `@throws`, the problem codes it ignores, and the paths the analyzer and the
  linter skip.
- Every linter rule that applies to the project's PHP version and
  integrations, with Mago's own name and description: filter them, turn each
  on or off, and set its level. A changed rule has a blue edge.

The first two are project settings you can share in `tusk.json`
(`phpAnalysis`). The rest live in `mago.toml`: Tusk edits the file in place,
keeping your comments and every key the page doesn't show, and Mago uses the
change at once. A project without a `mago.toml` uses Tusk's defaults; your
first change creates `mago.toml` from them. **Open mago.toml** edits the file
by hand.

### PHPStan

When the project has `vendor/bin/phpstan`, Tusk runs it on each PHP file as
it opens and each time you save it, with the project's own configuration, and
shows its problems with source `phpstan`. **Settings > PHPStan** (a **This
project** group) sets:

| Setting | Default |
| --- | --- |
| Run PHPStan: when the project has it, always, or never | When the project has `vendor/bin/phpstan` |
| Check files: as they open and on save, or only when you run it | As they open and on save |
| Configuration file: found by PHPStan, or one of the `.neon` files in the project's root | Found by PHPStan (`phpstan.neon`, `phpstan.neon.dist`, `phpstan.dist.neon`) |
| Rule level: the configuration's, or 0 to 10 or max | The configuration's |
| Memory limit | `2G` |
| Timeout | 180 seconds |

Changes apply at once: the open files are checked again with the new
settings, and turning PHPStan off clears its problems. Check **Share in
tusk.json** to give your team the same settings (the `phpstan` key).

**Code > Run PHPStan on Project** checks every file in the configuration's
`paths` and lists the problems in the Problems panel. The **PHPStan** button in
the Problems panel's toolbar shows its state: running, off, or failed, with
the reason in its tooltip, such as a timeout or running out of memory. A
failure also shows once as a notification. Click the button to run PHPStan on
the project or open its settings.

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

## License

Tusk is licensed under the [Functional Source License, Version 1.1, MIT Future License](LICENSE.md) (FSL-1.1-MIT). You can use, change, and share Tusk for any purpose except offering it, or something built from it, as a competing commercial product. Two years after each version is released, that version also becomes available under the MIT license.
