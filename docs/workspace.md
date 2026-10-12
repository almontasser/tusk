# The workspace

## The window

- **Title bar:** the project name (click it for a dropdown to switch to a
  recent project, open a folder, create a Laravel project, or close the project), the current branch and its pull request, a **Search everywhere**
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
  indexing, the cursor position (click it to go to a line), the indentation
  (click it to convert indents to spaces or tabs), the encoding and line
  endings, and the file's language (click it to pick another one for the file).
- **Welcome screen:** without an open folder, the window lists your recent
  projects. Tab and Enter open one. To remove one from the list, click the ×
  that shows when you point at it or tab to it, or right-click it.

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
| ⌥⌘← and ⌥⌘→ | Navigate back and forward through the places the cursor jumped from: another file, or more than 10 lines away |
| ⇧⌘⌫ | Go to the last edit location |
| ⇧⌘T | Go to the test of the current class (`UserTest.php` for `User.php`), or from a test to its class |
| ⌃↓ and ⌃↑ | Next and previous method or function (on a Mac, turn off Mission Control's ⌃↑ and ⌃↓ in System Settings first) |
| ⇧⌘] and ⇧⌘[ | Select the next and previous editor tab |
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
| ⌥⌘L | Reformat the file with the project's formatter, or only the selection when PHP formats with Mago |
| ⌘N | In a PHP file, generate code (constructor, getters and setters, `__toString()`, methods to implement or override); elsewhere, a new file in the selected folder |
| ⇧⌘C | Copy the path of the selected or active file |
| ⌥F12 | Show or hide the terminal |
| ⇧⌘' | Maximize the bottom panel, or restore it |
| ⇧⎋ | Hide the bottom panel, while you work in it |
| ⌘F in a terminal | Find in the terminal's output |
| ⌘K in a terminal | Clear the terminal (on a Mac; Ctrl+K stays the shell's elsewhere) |
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
| ⌥⌘T | Surround the selected lines, or the caret's line, with `if`, `foreach`, `try`/`catch`, a closure, and more (`@if`, `@foreach`, `@auth`, `@php` in Blade) |
| ⇧⌘V | Paste from history: one of the last 20 texts you copied or cut in an editor |
| ⇧⌘8 | Column selection mode: dragging or ⇧ and the arrows select a block |
| ⌃⌥I | Auto-indent lines |
| ⌘= and ⌘- | Expand or collapse the fold at the caret (with ⌥, recursively; with ⇧, all) |

The View menu and ⌘⇧A also have **Soft-Wrap**, **Show Minimap**, and **Show
Whitespaces**, which switch those settings, and **Increase Font Size**,
**Decrease Font Size**, and **Reset Font Size**. They have no shortcut until
you give them one.

Monaco's other editing commands, such as sorting lines, changing case, and
folding by level, are in the Edit and Code menus and in Find Action, with
Monaco's own shortcuts where it has them (such as ⌘K ⌘X to trim trailing
whitespace). The keymap editor can give them other shortcuts; a two-key chord
such as ⌘K ⌘X stays Monaco's and can't be changed there.

To open a folder, click **Open Folder…** in the sidebar or run the **Open
Folder…** action. **Close Project**, in the **File** menu or the project
dropdown in the title bar, saves the project's session, closes its tabs and
terminals, stops its language servers, and returns to the welcome screen.

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
  Tusk applies it. A change you make elsewhere, such as picking a theme, shows
  in the open file; if the file has unsaved edits, a message says so instead,
  since saving them replaces the change.
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
| Show whitespace (dots and arrows, except single spaces between words) | Off |
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
| Limits: ask before opening a file larger than | 20 MB |
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
panel, and the editor tab otherwise; only that tab's underline is in the accent color. Right-click a terminal to copy, paste,
select all, or clear it; on a Mac, ⌘K clears the focused terminal too. Click **+** at the end of the panel's tab bar for a
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

When another program, such as `git checkout`, changes an open file, the tab
reloads it as one edit, so ⌘Z brings back what you had. If the tab has unsaved
changes, a bar above the editor says the file changed on disk: **Reload** takes
the file's text, and **Keep Mine** keeps yours, which then saves over it. Saving
before you choose asks whether to overwrite the file, reload it, or cancel;
automatic saving skips the file and shows the bar instead. When the file
watcher loses events, as after a large checkout, Tusk checks every open file
and every folder shown in the tree.

Opening a file larger than 20 MB asks first, since large files can slow the
editor; **Settings > Limits** changes the size.

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
save every file they change. A recent project whose folder is gone shows
**Folder not found**, with a button that removes it from the list, and the open
project stays open.

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
| `phpAnalysis` | The PHP index: `loadAllLibraries`, `stubs`, comma-separated folders or files read as library code, and `lazyLoadingHints`. |
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

Right-click an editor tab to close it, the others, all of them, or those to its
right, to split it, to rename its file, or to copy its path. **Window > Editor
Tabs** has the same closing actions for the focused pane, and **Reopen Closed
Tab**, which reopens the most recently closed file that still exists.

## Files

Right-click the project tree for **New File…**, **New Folder…**, **Rename…**,
**Move to Trash**, **Find in Folder…** (Find in Files limited to the folder),
**Open in Terminal**, **Copy Path**, **Copy Relative Path**, and **Reveal in
Finder**. Test files, and folders in `tests`, also get **Run Tests** and
**Debug Tests**, which run them as a temporary run configuration. In the tree,
you can also press:

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

