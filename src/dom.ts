// Builds DOM elements in one expression: h("button", { class: "primary", onclick }, "Save").
import { keyText } from "./platform.ts";

type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Omit<Partial<HTMLElementTagNameMap[K]>, "style"> & { class?: string; style?: string; data?: Record<string, string> };

/**
 * Replaces `el`'s children, keeping where its scrolled panes were: a designer redraws itself whole after each
 * change, and would otherwise jump to the top. Panes are matched by class and order.
 */
export function redraw(el: HTMLElement, ...children: Child[]) {
  const scrolled = [...el.querySelectorAll<HTMLElement>("*")].filter((e) => e.scrollTop && e.className).map((e) => [e.className, [...el.getElementsByClassName(e.className)].indexOf(e), e.scrollTop] as const);
  el.replaceChildren(...children.filter((c): c is Node | string => !!c));
  for (const [cls, i, top] of scrolled) {
    const e = el.getElementsByClassName(cls)[i];
    if (e) e.scrollTop = top;
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {} as Props<K>, ...children: Child[]) {
  const e = document.createElement(tag);
  const { class: className, style, data, ...rest } = props;
  if (className) e.className = className;
  if (style) e.style.cssText = style;
  Object.assign(e, rest);
  for (const [k, v] of Object.entries(data ?? {})) e.dataset[k] = v;
  e.append(...(children.filter((c) => c !== null && c !== undefined && c !== false) as (Node | string)[]));
  return e;
}

export const icon = (name: string) => h("span", { class: `codicon codicon-${name}` });
// Tooltips name keys as the Mac draws them (⌘W); keyText names them as this platform does.
export const iconButton = (name: string, title: string, onclick: () => unknown) => h("button", { class: "icon-button", title: keyText(title), onclick }, icon(name));

/**
 * Shows a message in the corner. An error closes itself after 10 seconds and a notice after 6; a hint with an
 * action stays until you act on it or close it, or for `timeout` ms. A toast waits while the pointer is over it.
 */
type ToastAction = { label: string; run(): unknown };

export function toast(text: string, { kind = "error", action, timeout }: { kind?: "error" | "info"; action?: ToastAction | ToastAction[]; timeout?: number } = {}) {
  const actions = action ? [action].flat() : [];
  if (kind === "error") console.warn(`[toast] ${text}`); // So an error can be traced after the toast closes.
  const close = () => el.remove();
  // Git's "hint:" lines repeat advice; the first lines carry the error.
  const message = keyText(text.split("\n").filter((l) => l.trim() && !l.startsWith("hint:")).join(" "));
  // The same message twice, such as from a failure that repeats, shows once while its toast is up.
  const shown = [...document.querySelectorAll<HTMLElement>(`#toasts .toast.${kind} p`)].some((p) => p.textContent === message);
  if (shown) return;
  const buttons = actions.map((a) => h("button", { class: "toast-action", onclick: () => (close(), a.run()) }, a.label));
  const el = h(
    "div",
    { class: `toast ${kind}` },
    icon(kind),
    // One button sits beside the message; more go on a row below it, so the message keeps its width.
    actions.length > 1 ? h("div", { class: "toast-body" }, h("p", {}, message), h("div", { class: "toast-actions" }, ...buttons)) : h("p", {}, message),
    ...(actions.length > 1 ? [] : buttons),
    h("button", { class: "codicon codicon-close", ariaLabel: "Dismiss", onclick: close }),
  );
  // In a modal dialog, the toasts go in the dialog, since its backdrop covers the page; they return when it closes.
  const box = document.getElementById("toasts")!;
  const dialog = document.querySelector("dialog[open]");
  if (dialog && box.parentElement !== dialog) dialog.addEventListener("close", () => document.body.append(box), { once: true });
  (dialog ?? document.body).append(box);
  box.append(el);
  if (actions.length && !timeout) return;
  let left = timeout ?? (kind === "error" ? 10000 : 6000);
  let start = Date.now();
  let timer = setTimeout(close, left);
  el.onmouseenter = () => (clearTimeout(timer), (left -= Date.now() - start));
  el.onmouseleave = () => ((start = Date.now()), (timer = setTimeout(close, Math.max(left, 2000))));
}

// A cut-off label shows its whole text on hover. A title of its own wins; one set here follows the text. Tests
// load this module without a document.
globalThis.document?.addEventListener("mouseover", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || (el.title && !el.dataset.autoTitle)) return;
  if (el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis") (el.title = el.textContent ?? ""), (el.dataset.autoTitle = "1");
  else if (el.dataset.autoTitle) el.removeAttribute("title"), delete el.dataset.autoTitle;
});

// The wheel scrolls a tab strip sideways.
globalThis.document?.addEventListener(
  "wheel",
  (e) => {
    const tabs = (e.target as Element).closest?.(".tabs, #terminal-tabs");
    if (!tabs || !e.deltaY || e.deltaX) return;
    tabs.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false },
);
