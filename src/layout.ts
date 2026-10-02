// The window's layout: the sidebar's and the bottom panel's sizes, where the panel sits, and maximizing it.
// The panel sits under the editor, beside the sidebar, or with Full-Width Bottom Panel on, across the window under
// both, as PhpStorm can. Maximized, it fills its column: the editor area, or with a full-width panel, the sidebar's too.
import { showMenu } from "./files";
import { splitter } from "./splitter";
import { hidePanel, revealPanel } from "./terminal";
import { keyText } from "./platform.ts";

const $ = (id: string) => document.getElementById(id)!;
const FULL_WIDTH_KEY = "panelFullWidth";
let host = { focusEditor() {}, status(_text: string) {} };

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const panelFullWidth = () => $("workbench").classList.contains("panel-full-width");
export const panelMaximized = () => $("workbench").classList.contains("panel-maximized");

/** Moves the bottom panel across the window's full width, or back under the editor, and remembers the choice. */
export function setPanelFullWidth(on: boolean) {
  const panel = $("panel");
  const focused = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  $("workbench").classList.toggle("panel-full-width", on);
  (on ? $("workarea") : document.querySelector("main")!).append(panel);
  focused?.focus(); // Moving an element takes focus from it.
  try {
    localStorage.setItem(FULL_WIDTH_KEY, String(on));
  } catch {}
}

export const togglePanelFullWidth = () => setPanelFullWidth(!panelFullWidth());

function setMaximized(on: boolean) {
  $("workbench").classList.toggle("panel-maximized", on);
  const button = $("panel-maximize");
  button.title = keyText(on ? "Restore (⇧⌘')" : "Maximize (⇧⌘')");
  button.ariaPressed = String(on);
  button.firstElementChild!.className = `codicon codicon-${on ? "screen-normal" : "screen-full"}`;
}

/**
 * Maximizes the bottom panel, or restores it, as PhpStorm's ⇧⌘' does. Maximizing shows the panel if it's hidden and
 * focuses its tab, since the editor goes away; with no tabs, there's nothing to maximize.
 */
export function togglePanelMaximized() {
  if (panelMaximized()) return setMaximized(false);
  if (!revealPanel()) return host.status("The bottom panel has no tabs. Open a terminal or another tool window first.");
  setMaximized(true);
}

/** The panel's options menu, as PhpStorm's tool window options (⋮). */
function panelOptions(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, [
    { label: `${panelFullWidth() ? "✓ " : ""}Full-Width Bottom Panel`, run: togglePanelFullWidth },
    { label: panelMaximized() ? "Restore Size" : "Maximize", keys: "⇧⌘'", run: togglePanelMaximized },
    "-",
    { label: "Hide", keys: "⇧⎋", run: hidePanel },
  ]);
}

/** Sets up the sidebar and panel splitters, the panel's title bar buttons, and the saved layout. */
export function initLayout(h: typeof host) {
  host = h;
  splitter($("sidebar-resize"), {
    target: $("sidebar"),
    axis: "x",
    edge: "end",
    label: "Resize the sidebar",
    min: 180,
    minRest: 240,
    max: () => innerWidth * 0.6,
    save: "sidebar",
    legacyKey: "sidebarWidth",
  });
  splitter($("panel-resize"), { target: $("panel"), axis: "y", edge: "start", label: "Resize the bottom panel", min: 80, minRest: 100, save: "panel" });
  if (read(FULL_WIDTH_KEY) === "true") setPanelFullWidth(true);

  $("panel-maximize").onclick = togglePanelMaximized;
  $("panel-options").onclick = (e) => panelOptions(e.currentTarget as HTMLElement);
  $("panel-hide").onclick = hidePanel;

  // When the panel hides, however that happens, it's no longer maximized, and focus goes back to the editor
  // rather than to nowhere.
  new MutationObserver(() => {
    if (!$("panel").hidden) return;
    if (panelMaximized()) setMaximized(false);
    const focused = document.activeElement;
    if (!focused || focused === document.body || $("panel").contains(focused)) host.focusEditor();
  }).observe($("panel"), { attributes: true, attributeFilter: ["hidden"] });
}
