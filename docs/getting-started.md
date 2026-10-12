# Getting started

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

