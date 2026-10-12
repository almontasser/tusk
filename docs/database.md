# Database

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

