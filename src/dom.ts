// Builds DOM elements in one expression: h("button", { class: "primary", onclick }, "Save").
type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Omit<Partial<HTMLElementTagNameMap[K]>, "style"> & { class?: string; style?: string; data?: Record<string, string> };

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
