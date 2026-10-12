# Tests, debugging, and profiling

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
| PHP web server | `php artisan serve`, or PHP's built-in server with a document root, on a host and port, or at `https://<domain>.test` |

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

#### Local .test domains

A PHP web server configuration can serve your app at `https://<domain>.test`,
with a trusted certificate, instead of at a host and port. To use it, turn on
**Serve at https://‹domain›.test** in the configuration, and optionally enter a
**Domain**. Without one, Tusk uses the project folder's name, so a project in
`My Shop` serves at `https://my-shop.test`.

When you click **Run**, Tusk does the rest:

- The first time, Tusk creates its own local certificate authority, trusts it,
  and routes `.test` names to this computer. Your system asks for your
  password. On macOS, it also asks you to trust the certificate. On older
  Linux systems, each new domain asks for your password again.
- Tusk starts PHP's built-in server on a free port, with a router that marks
  each request as HTTPS, and serves it at the domain through a proxy built into
  Tusk. For Laravel, the router runs Laravel's own `server.php`, as
  `php artisan serve` does, so `url()` and `request()->isSecure()` see HTTPS.
- The terminal tab's first line, and a notification with **Open in Browser**,
  show the address.

The address has no port when Tusk can use port 443. Otherwise it's
`https://<domain>.test:8443`, or another free port when 8443 is taken. On Linux, the notification then offers
**Use Port 443…**, which asks for your password once; rerun the server
afterwards. Stopping the run stops serving the domain. Opening a domain that
isn't running shows a page with a **Run** button when an open Tusk window has
its configuration; the page turns into your site once it's up. To have that page
answer before you've run anything, turn on **Settings > .test Domains > Start
the .test proxy with Tusk**. The domains work only
while Tusk runs, and a configuration served at a `.test` domain can't run in
Docker.

To undo the setup, run **Run > Remove .test Domains and Certificate**. Tusk
stops its `.test` servers, removes its certificate from your system's trusted
certificates, and removes its `.test` DNS setting. Your system asks for your
password: once on Windows and Linux, and twice on macOS.

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
current commit, or open it. **Copy Remote URL** in ⌘⇧A
copies the link to the selected lines, and **Open on GitHub** opens it in your
browser. While execution is paused, **Run to Line** resumes
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

