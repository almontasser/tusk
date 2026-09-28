// Resizable splits: a handle you drag, move with the arrow keys when it has focus, or double-click to reset.
// It sizes one pane (the target) in pixels, within limits, and can remember the size in localStorage, per window.
import { getCurrentWindow } from "@tauri-apps/api/window";

export type SplitterOptions = {
  /** The pane whose width ("x") or height ("y") the handle sets. */
  target: HTMLElement;
  axis: "x" | "y";
  /**
   * Where the handle is: "end" after the target (to its right or below it), so dragging right or down grows it,
   * or "start" before it (to its left or above it), so dragging left or up grows it.
   */
  edge: "start" | "end";
  /** An accessible name, such as "Resize the call stack". */
  label: string;
  /** The smallest size, in pixels. 80 by default. */
  min?: number;
  /** What the rest of the container keeps at least, in pixels, so the other pane never disappears. 80 by default. */
  minRest?: number;
  /** The largest size, when the container's size minus `minRest` isn't the limit, such as the window's for the sidebar. */
  max?: () => number;
  /** A name to remember the size under, per window. Without it, the size lasts until the view closes. */
  save?: string;
  /** A localStorage key an older version kept the size under, read while there's no size saved under `save`. */
  legacyKey?: string;
  /** Runs after the size changes, such as to fit a terminal. */
  onResize?(size: number): void;
};

const windowLabel = (() => {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main"; // Outside Tauri, such as in a plain browser.
  }
})();
const storageKey = (name: string) => `split:${windowLabel}:${name}`;

/** The size a splitter saved under `name`, or null. */
export function savedSize(name: string): number | null {
  try {
    const n = Number(localStorage.getItem(storageKey(name)));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Makes `handle` resize `target`. The handle gets the separator role, focus, and the arrow keys (Shift for bigger
 * steps, Home and End for the limits); a double-click goes back to the size the CSS gives. Returns a function that
 * applies the saved size again, clamped to the space there is now.
 */
export function splitter(handle: HTMLElement, o: SplitterOptions) {
  const horizontal = o.axis === "x";
  const min = o.min ?? 80;
  handle.classList.add("splitter", horizontal ? "splitter-x" : "splitter-y");
  handle.role = "separator";
  handle.tabIndex = 0;
  handle.ariaLabel = o.label;
  handle.ariaOrientation = horizontal ? "vertical" : "horizontal";
  handle.removeAttribute("aria-hidden");

  const current = () => (horizontal ? o.target.offsetWidth : o.target.offsetHeight);
  const max = () => {
    const parent = o.target.parentElement;
    const space = parent ? (horizontal ? parent.clientWidth : parent.clientHeight) : 0;
    // A container that isn't showing yet has no size to limit by; the size is clamped again when it's dragged.
    const room = space ? space - (o.minRest ?? 80) : Infinity;
    return Math.max(min, Math.min(room, o.max?.() ?? Infinity));
  };
  const set = (size: number, save = true) => {
    const clamped = Math.round(Math.max(min, Math.min(max(), size)));
    o.target.style[horizontal ? "width" : "height"] = `${clamped}px`;
    handle.ariaValueNow = String(clamped);
    handle.ariaValueMin = String(min);
    handle.ariaValueMax = String(Math.round(max()));
    if (save && o.save)
      try {
        localStorage.setItem(storageKey(o.save), String(clamped));
      } catch {}
    o.onResize?.(clamped);
  };
  // Dragging toward the target's far side grows it: right or down for a handle at its end, left or up at its start.
  const sign = o.edge === "end" ? 1 : -1;

  handle.onpointerdown = (down) => {
    if (down.button !== 0) return;
    down.preventDefault(); // Otherwise the drag selects the text it passes over.
    try {
      handle.setPointerCapture(down.pointerId); // So the drag goes on over an iframe or the terminal.
    } catch {}
    handle.classList.add("dragging");
    document.body.classList.add(horizontal ? "resizing-x" : "resizing-y");
    const start = current();
    const from = horizontal ? down.clientX : down.clientY;
    const move = (e: PointerEvent) => set(start + sign * ((horizontal ? e.clientX : e.clientY) - from), false);
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing-x", "resizing-y");
      set(current());
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
  handle.onkeydown = (e) => {
    const step = e.shiftKey ? 50 : 10;
    // The arrow keys move the handle, the way it points.
    const moves: Record<string, number> = horizontal ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
    if (e.key in moves) set(current() + sign * moves[e.key]);
    else if (e.key === "Home") set(min);
    else if (e.key === "End") set(max());
    else if (e.key === "Enter") reset();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const reset = () => {
    o.target.style[horizontal ? "width" : "height"] = "";
    if (o.save)
      try {
        localStorage.removeItem(storageKey(o.save));
      } catch {}
    handle.ariaValueNow = String(current());
    o.onResize?.(current());
  };
  handle.ondblclick = reset;

  const restore = () => {
    let saved = o.save ? savedSize(o.save) : null;
    if (!saved && o.legacyKey)
      try {
        saved = Number(localStorage.getItem(o.legacyKey)) || null;
      } catch {}
    if (saved) set(saved, false);
  };
  restore();
  return restore;
}
