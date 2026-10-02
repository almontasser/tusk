// What differs between macOS, Windows, and Linux in the page. Paths in the app use `/` everywhere, with a lowercase
// drive letter on Windows (`c:/Users/me/app`), as Monaco's URIs and the backend's `slash()` write them; Windows takes
// either separator.
import * as dialog from "@tauri-apps/plugin-dialog";

const agent = globalThis.navigator?.userAgent ?? "";
export const isMac = /Mac/.test(agent);
export const isWindows = /Windows/.test(agent);
// For styles that differ, such as the title bar's room for the Mac's window buttons.
globalThis.document?.documentElement.classList.toggle("mac", isMac);

/** Whether the platform's command modifier is held: ⌘ on a Mac, Ctrl elsewhere. */
export const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

const MOD_NAMES: [string, string][] = [["⌘", "Ctrl"], ["⌃", "Win"], ["⌥", "Alt"], ["⇧", "Shift"]];
const KEY_NAMES: Record<string, string> = { "⏎": "Enter", "⌫": "Backspace", "⌦": "Delete", "⎋": "Esc", "⇥": "Tab", "-click": "click" };

/**
 * Text with keys written as a Mac draws them (`⌥⌘Z`), as this platform names them: unchanged on a Mac, else as words
 * (`Ctrl+Alt+Z`), with Ctrl for ⌘ and the Windows key for ⌃ as the keymap reads them (see `comboOf` in main.ts). A
 * double tap such as `⇧⇧` stays a double tap, and `⌃⌃` is Ctrl's. A key on its own, such as `⏎`, and a click, such
 * as `⌘-click`, read as words too.
 */
export const keyText = (text: string, mac = isMac) =>
  mac
    ? text
    : text
        .replace(/([⌘⌃⌥⇧]+)(-click\b|[⏎⌫⌦⎋⇥]|[A-Za-z0-9]+\b|F\d+|[^\s⌘⌃⌥⇧]?)/g, (_, mods: string, key: string) => {
          if (!key && mods.length === 2 && mods[0] === mods[1]) return `${mods[0] === "⌃" ? "Ctrl" : MOD_NAMES.find(([g]) => g === mods[0])![1]} ${mods[0] === "⌃" ? "Ctrl" : MOD_NAMES.find(([g]) => g === mods[0])![1]}`;
          const names = MOD_NAMES.filter(([g]) => mods.includes(g)).map(([, n]) => n);
          return [...names, KEY_NAMES[key] ?? key].filter(Boolean).join("+");
        })
        .replace(/[⏎⌫⌦⎋⇥]/g, (key) => KEY_NAMES[key]);

// Keys as the keymap writes them (`Meta+Shift+F`), drawn as a Mac does (`⇧⌘F`); keyText turns them into words elsewhere.
const KEY_SYMBOLS: Record<string, string> = {
  Delete: "⌦", Backspace: "⌫", Enter: "⏎", Escape: "⎋", Tab: "⇥", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space",
  Slash: "/", Backslash: "\\", Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Backquote: "`", Semicolon: ";", Quote: "'",
};
const macSymbols = (keys: string) =>
  keys
    .replace(/^(\w+) \1$/, "$1+$1+")
    .replace(/Ctrl\+/g, "⌃")
    .replace(/Alt\+/g, "⌥")
    .replace(/Shift\+/g, "⇧")
    .replace(/Meta\+/g, "⌘")
    .replace(/[A-Z][a-z]+[A-Za-z]*$/, (key) => KEY_SYMBOLS[key] ?? key);
/** A keymap shortcut as this platform names it: `⇧⌘F` on a Mac, `Ctrl+Shift+F` elsewhere. */
export const shortcutText = (keys?: string, mac = isMac) => keys && keyText(macSymbols(keys), mac);

/** Whether a path is absolute: `/…`, or `c:/…` on Windows. */
export const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

/** A path from outside the app, such as a dialog, written the app's way. */
export const normalizePath = (path: string) =>
  isWindows ? path.replaceAll("\\", "/").replace(/^[A-Z](?=:)/, (d) => d.toLowerCase()) : path;

type Picked = string | string[] | null;
const normalized = <T extends Picked>(picked: T): T =>
  (picked === null ? null : Array.isArray(picked) ? picked.map(normalizePath) : normalizePath(picked)) as T;

/** The file dialogs, returning paths written the app's way. */
export const open: typeof dialog.open = (async (options?: dialog.OpenDialogOptions) => normalized(await dialog.open(options))) as typeof dialog.open;
export const save = async (options?: dialog.SaveDialogOptions) => normalized(await dialog.save(options));
