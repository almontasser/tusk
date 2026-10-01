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
