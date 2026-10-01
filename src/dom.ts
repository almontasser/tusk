// Builds DOM elements in one expression: h("button", { class: "primary", onclick }, "Save").
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
export const iconButton = (name: string, title: string, onclick: () => unknown) => h("button", { class: "icon-button", title, onclick }, icon(name));

/**
 * Shows a message in the corner. An error closes itself after 6 seconds; a hint with an action stays until
 * you act on it or close it, or for `timeout` ms, as for a notice of what just happened.
 */
export function toast(text: string, { kind = "error", action, timeout }: { kind?: "error" | "info"; action?: { label: string; run(): unknown }; timeout?: number } = {}) {
  if (kind === "error") console.warn(`[toast] ${text}`); // So an error can be traced after the toast closes.
  const close = () => el.remove();
  // Git's "hint:" lines repeat advice; the first lines carry the error.
  const message = text.split("\n").filter((l) => l.trim() && !l.startsWith("hint:")).join(" ");
  // The same message twice, such as from a failure that repeats, shows once while its toast is up.
  const shown = [...document.querySelectorAll<HTMLElement>(`#toasts .toast.${kind} p`)].some((p) => p.textContent === message);
  if (shown) return;
  const el = h(
    "div",
    { class: `toast ${kind}` },
    icon(kind),
    h("p", {}, message),
    action && h("button", { class: "toast-action", onclick: () => (close(), action.run()) }, action.label),
    h("button", { class: "codicon codicon-close", ariaLabel: "Dismiss", onclick: close }),
  );
  document.getElementById("toasts")!.append(el);
  if (!action || timeout) setTimeout(close, timeout ?? 6000);
}
