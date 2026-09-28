// The native menu bar. Its items run the same actions as Find Action, looked up by label.
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { commandsIn } from "./editorcommands.ts";

type Action = { label: string; keys?: string; run(): unknown; editorOnly?: boolean; when?: () => boolean };
type Native = { native: "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll" | "Services" | "Hide" | "HideOthers" | "ShowAll" | "Quit" | "Minimize" | "Maximize" | "Fullscreen" };
/** An action label, a separator (`-`), a native item, or a submenu. */
type Entry = string | Native | [string, Entry[]];

const native = (name: Native["native"]): Native => ({ native: name });

const LAYOUT: [string, Entry[]][] = [
  ["Tusk", ["About", "Check for Updates…", "-", "Settings…", "Keymap…", "-", native("Services"), "-", native("Hide"), native("HideOthers"), native("ShowAll"), "-", "Quit Tusk"]],
  ["File", ["New File…", "New Folder…", "Open Folder…", "Recent Files", "-", "Save All", "Close Tab", "-", "Rename File…", "Move File to Trash", "Copy Path", "Copy Reference", "Reveal in Finder", "Change File Encoding…", "-",
    ["Compare", ["Compare with Clipboard", "Compare with File…"]],
    ["Local History", ["Show Local History", "Local History: Deleted Files…"]]]],
  ["Edit", [native("Undo"), native("Redo"), "-", native("Cut"), native("Copy"), native("Paste"), native("SelectAll"), "-",
    ["Find", [...commandsIn("find"), "-", "Add Selection for Next Occurrence", "Select All Occurrences", "Change All Occurrences", "-", "Find in Files", "Replace in Files"]],
    ["Multiple Carets", ["Add Caret Above", "Add Caret Below", "Add Carets to Line Ends"]], "-",
    "Extend Selection", "Shrink Selection", "-", "Duplicate Line", "Delete Line", "Join Lines", "Toggle Case",
    ["Change Case", commandsIn("case")], ["Lines", commandsIn("lines").filter((l) => l !== "Join Lines")], ["Indentation", [...commandsIn("indent").slice(0, 2), "-", ...commandsIn("indent").slice(2)]], "-",
    "Toggle Bookmark", "Show Bookmarks", "Edit Snippets (Live Templates)"]],
  ["View", ["Show Project", "Problems", "Git Log", "Terminal", "New Terminal", "Find in Terminal", "Rename Terminal Tab…", "Debug Panel", "TODO", "Database", "Composer", "HTTP Client", "Pull Requests", "-",
    "Maximize Bottom Panel", "Hide Bottom Panel", "Toggle Full-Width Bottom Panel", "-",
    "Split Right", "Split Down", "Move Tab to Next Pane", "Unsplit", "-", "Markdown Preview", "-", "Color Theme…", "Import Color Theme…", "Remove Imported Color Theme…", "Toggle Inline Problems", "Toggle AI Completion", "-", native("Fullscreen")]],
  ["Navigate", ["Search Everywhere", "Find Action", "Go to File", "Go to Class", "Go to Symbol", "Go to Request…", "File Structure", "Select Opened File in Project", "-",
    "Go to Declaration", "Go to Implementation", "Go to Type Declaration", "Go to Super Method", "Find Usages", "Type Hierarchy", "Call Hierarchy", "-",
    ...commandsIn("navigate"), "-", "Next Problem", "Previous Problem", "Next Problem in Files", "Previous Problem in Files", "-", "Next Change", "Previous Change"]],
  ["Code", ["Generate…", "Show Context Actions", "Basic Completion", "Parameter Info", "Quick Documentation", "-",
    ...commandsIn("comment"), "Reformat Code", "Auto-Indent Lines", "Optimize Imports", "Fix All Safe Problems in File", "-",
    ["Folding", ["Expand", "Collapse", "Toggle Fold", "Expand Recursively", "Collapse Recursively", "-", "Expand All", "Collapse All", ["Collapse to Level", commandsIn("fold-level")], "-",
      "Collapse Doc Comments", "Collapse Regions", "Expand Regions", "-", "Fold Selection"]], "-",
    "Move Line Up", "Move Line Down", "-", "Scan Project for Problems", "Hide Coverage", "Show Tests Covering Line"]],
  ["Refactor", ["Refactor This…", "-", "Rename", "Change Signature…", "-", "Extract Variable…", "Extract Constant…", "Extract Method…", "Introduce Field…", "Introduce Parameter…", "Inline…", "-", "Pull Members Up…", "Extract Interface…", "Move Class…", "Safe Delete…"]],
  ["Run", ["Run", "Debug", "Run with Coverage", "Stop", "Rerun", "-", "Run…", "Debug…", "Edit Configurations…", "Save Temporary Configuration", "-", "Run Anything", "-", "Run Test at Cursor", "Debug Test at Cursor", "Run Test at Cursor with Coverage", "Run All Tests", "Run All Tests with Coverage", "-",
    "Start Listening for PHP Debug Connections", "Start Debug Server (php artisan serve with Xdebug)", "Stop Debugging", "Resume Program", "Step Over", "Step Into", "Step Out", "-",
    "Toggle Breakpoint", "Edit Breakpoint…", "View Breakpoints…", "Toggle Pause on Exceptions", "Pause on Exception Classes…", "Pause on Exceptions Options…", "Choose Xdebug Port…", "Set Server Paths for Debugging…", "-",
    ["Profile", ["Profile Test at Cursor", "Profile URL…", "Start Profiling Server (PHP's server with the Xdebug profiler)", "Open Xdebug Profile…"]]]],
  ["Tools", [
    ["HTTP Client", ["Send HTTP Request", "HTTP Client: New Request…", "Select HTTP Environment…", "HTTP Client: Edit Environments", "HTTP Client: Global Variables…", "HTTP Client: Detect App Address", "HTTP Client: Clear Cookies", "-",
      "HTTP Client: Run All Requests in Project", "HTTP Client: Sync with Laravel Routes…", "HTTP Client: Import…", "HTTP Client: Export to OpenAPI…"]],
    ["Database", ["Open Query Console", "Execute Query", "-", "Database: Switch Connection…", "Database: Connect over SSH…"]],
    ["Composer", ["Composer: Require Package…", "Composer: Update All"]],
    ["Laravel", ["Laravel Tinker", "Routes"]],
    "-", "Choose Docker Service for Commands…", "Restart Language Servers", "Reindex Project", "Index Exclusions…", "Share Project Settings in tusk.json…"]],
  ["Git", ["Commit…", "Push…", "Update Project", "Fetch", "-", "Branches…", "Worktrees…", "Stash Changes…", "Stashes…", "Interactive Rebase…", "Resolve Conflicts in Merge Tool", "Stage Selected Changes (in a diff)", "-", "Initialize Repository", "-",
    "Annotate with Git Blame", "Show File History", "Copy Remote URL", "-", "Create Pull Request…"]],
  ["Window", [native("Minimize"), native("Maximize")]],
  ["Help", ["Find Action", "Keyboard Shortcuts", "Keymap…"]],
];

/**
 * The menu shortcut for an action, in Tauri's accelerator format. Double taps such as ⇧⇧ and chords such as
 * ⌘K ⌘X have no menu equivalent.
 */
export function accelerator(a: Pick<Action, "keys">) {
  if (!a.keys || a.keys.includes(" ")) return undefined;
  return a.keys.replace("Meta", "Cmd");
}

/**
 * The web view sees a key first, and the menu gets it only when the page doesn't handle it. An action that passes
 * some keys on (editor-only actions outside the editor, debugger steps while running) must not run then, so the
 * menu ignores it right after a key press: a menu item picked with the pointer or the menu's own keys comes later.
 */
let lastKey = -Infinity;
globalThis.addEventListener?.("keydown", () => (lastKey = performance.now()), true);
export const passedOn = (a: Pick<Action, "editorOnly" | "when">, now = performance.now(), last = lastKey) => !!(a.editorOnly || a.when) && now - last < 500;

let current: Menu | undefined;

/** Builds the menu bar from the actions and makes it the app's menu. Run it again after the keymap changes. */
export async function setMenu(actions: Action[]) {
  const byLabel = new Map(actions.map((a) => [a.label, a]));
  const build = async (entry: Entry, parent: string): Promise<MenuItem | PredefinedMenuItem | Submenu | undefined> => {
    if (entry === "-") return PredefinedMenuItem.new({ item: "Separator" });
    if (entry === "About") return PredefinedMenuItem.new({ item: { About: null }, text: "About Tusk" });
    if (typeof entry === "object" && "native" in entry) return PredefinedMenuItem.new({ item: entry.native });
    if (Array.isArray(entry)) return submenu(entry[0], entry[1]);
    const action = byLabel.get(entry);
    if (!action) return void console.error(`Menu: no action named "${entry}"`);
    // Inside the HTTP Client submenu, "HTTP Client: Import…" reads as "Import…".
    const text = entry.startsWith(`${parent}: `) ? entry.slice(parent.length + 2) : entry;
    return MenuItem.new({ text, accelerator: accelerator(action), action: () => passedOn(action) || action.run() });
  };
  const submenu = async (text: string, entries: Entry[]) =>
    Submenu.new({ text, items: (await Promise.all(entries.map((e) => build(e, text)))).filter((i) => !!i) });
  const menus = await Promise.all(LAYOUT.map(([text, entries]) => submenu(text, entries)));
  const menu = await Menu.new({ items: menus });
  await menu.setAsAppMenu();
  await menus.at(-2)!.setAsWindowsMenuForNSApp();
  await menus.at(-1)!.setAsHelpMenuForNSApp();
  const old = current;
  current = menu;
  await old?.close();
}
