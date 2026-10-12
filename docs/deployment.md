# Deployment

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

