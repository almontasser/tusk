// Small pieces the designers share: a popover anchored to an element, a prompt for a name with suggestions, a
// Heroicon picker that shows the icons themselves, a color chooser with Filament's colors, and a combobox.
import { invoke } from "@tauri-apps/api/core";
import { h, icon } from "./dom";
import { COLORS, heroiconCase, heroiconFile } from "./filamentcatalog";
import { mod } from "./platform.ts";

let closeOpen: (() => void) | null = null;

/**
 * Shows `content` in a popover under `anchor` (or at a point), and closes it on Escape, a click outside, or `close()`.
 * Only one popover shows at a time.
 */
export function popover(anchor: HTMLElement | { x: number; y: number }, content: HTMLElement, onClose: () => void = () => {}, className = "") {
  closeOpen?.();
  const el = h("div", { class: `fd-popover ${className}`, role: "dialog" }, content);
  (document.querySelector("dialog[open]") ?? document.body).append(el);
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y, right: anchor.x };
  const place = () => {
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const below = r.bottom + 4 + hgt <= innerHeight - 8;
    el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    el.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - hgt - 4)}px`;
  };
  place();
  const close = () => {
    if (!el.isConnected) return;
    el.remove();
    removeEventListener("mousedown", outside, true);
    removeEventListener("keydown", keys, true);
    closeOpen = null;
    onClose();
  };
  const outside = (e: MouseEvent) => !el.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node)) && close();
  const keys = (e: KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), close());
  addEventListener("mousedown", outside, true);
  addEventListener("keydown", keys, true);
  closeOpen = close;
  return { el, close, place };
}

export const closePopover = () => closeOpen?.();

/**
 * Asks for a name in a popover, suggesting `suggestions` (such as the model's columns not yet in the form) as you
 * type. Resolves to the name, or null when dismissed.
 */
export function askName(anchor: HTMLElement | { x: number; y: number }, o: { title: string; placeholder?: string; value?: string; suggestions?: { value: string; detail?: string }[]; validate?: (v: string) => string | null; action?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h("input", { class: "fd-ask-input", value: o.value ?? "", placeholder: o.placeholder ?? "", spellcheck: false, autocomplete: "off" });
    const list = h("div", { class: "fd-ask-list", role: "listbox" });
    const problem = h("p", { class: "fd-ask-problem" });
    const ok = h("button", { class: "primary", type: "button", textContent: o.action ?? "Add" });
    let index = 0;
    let shown: { value: string; detail?: string }[] = [];
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = (o.suggestions ?? []).filter((s) => !q || s.value.toLowerCase().includes(q)).slice(0, 40);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(
        ...shown.map((s, i) =>
          h(
            "div",
            { class: `fd-ask-item${i === index ? " active" : ""}`, role: "option", onmousedown: (e: MouseEvent) => (e.preventDefault(), (input.value = s.value), submit()) },
            h("span", { class: "fd-ask-value" }, s.value),
            s.detail ? h("span", { class: "fd-ask-detail" }, s.detail) : null,
          ),
        ),
      );
      list.hidden = !shown.length;
      problem.textContent = input.value.trim() && o.validate ? (o.validate(input.value.trim()) ?? "") : "";
    };
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      p.close();
      resolve(value);
    };
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      const bad = o.validate?.(v);
      if (bad) return void (problem.textContent = bad);
      finish(v);
    };
    input.oninput = () => ((index = 0), render());
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        index = (index + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        render();
      } else if (e.key === "Tab" && shown[index]) {
        e.preventDefault();
        input.value = shown[index].value;
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Enter takes the highlighted suggestion while what's typed only starts one.
        if (shown[index] && input.value.trim() && shown[index].value !== input.value.trim() && shown[index].value.toLowerCase().startsWith(input.value.trim().toLowerCase())) input.value = shown[index].value;
        submit();
      }
    };
    ok.onclick = submit;
    const p = popover(anchor, h("div", { class: "fd-ask" }, h("label", { class: "fd-ask-title" }, o.title), input, problem, list, h("div", { class: "fd-ask-buttons" }, h("button", { type: "button", textContent: "Cancel", onclick: () => finish(null) }), ok)), () => finish(null));
    render();
    requestAnimationFrame(() => (input.focus(), input.select()));
  });
}

// ---- Heroicons ----

const svgs = new Map<string, Promise<string>>();

/** A Heroicon's SVG, by file name such as `o-user`, read from blade-heroicons. */
export function heroiconSvg(dir: string | null, file: string): Promise<string> {
  if (!dir) return Promise.resolve("");
  let p = svgs.get(file);
  if (!p) {
    p = invoke<string>("read_file", { path: `${dir}/${file}.svg` }).then(
      (svg) => svg.replace(/<svg /, '<svg aria-hidden="true" '),
      () => "",
    );
    svgs.set(file, p);
  }
  return p;
}

/** An element that shows an icon by its Filament name (`heroicon-o-user`, `o-user`, or an enum case), once loaded. */
export function heroicon(dir: string | null, name: string | null | undefined, className = "fd-heroicon"): HTMLElement {
  const el = h("span", { class: className });
  if (!name) return el;
  // A solid icon's enum value has no style prefix: Heroicon::Cog6Tooth is `cog-6-tooth`.
  const file = /^(heroicon-)?[osmc]-/.test(name) ? name.replace(/^heroicon-/, "") : /^[a-z0-9-]+$/.test(name) ? `s-${name}` : heroiconFile(name.replace(/^Heroicon::/, ""));
  heroiconSvg(dir, file).then((svg) => {
    if (svg) el.innerHTML = svg;
    else el.replaceChildren(icon("symbol-misc"));
  });
  return el;
}

/**
 * Picks a Heroicon: a searchable grid, outlined or solid. Resolves to the enum case, such as `OutlinedUser`, or null.
 */
export function pickHeroicon(anchor: HTMLElement, o: { dir: string | null; cases: string[]; current?: string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const search = h("input", { class: "fd-icons-search", type: "search", placeholder: "Search icons", spellcheck: false });
    const style = h("select", { class: "fd-icons-style", ariaLabel: "Style" }, h("option", { value: "Outlined", textContent: "Outlined" }), h("option", { value: "", textContent: "Solid" }), h("option", { value: "Mini", textContent: "Mini" }));
    const grid = h("div", { class: "fd-icons-grid", role: "listbox" });
    const count = h("span", { class: "fd-icons-count" });
    const current = o.current ? (heroiconCase(o.current) ?? o.current.replace(/^Heroicon::/, "")) : null;
    if (current?.startsWith("Mini")) style.value = "Mini";
    else if (current && !current.startsWith("Outlined")) style.value = "";
    const render = () => {
      const q = search.value.trim().toLowerCase().replace(/[\s-]+/g, "");
      const prefix = style.value;
      const cases = o.cases.filter((c) => (prefix ? c.startsWith(prefix) : !/^(Outlined|Mini|Micro)/.test(c)) && (!q || c.slice(prefix.length).toLowerCase().includes(q)));
      count.textContent = `${cases.length} icons`;
      grid.replaceChildren(
        ...cases.slice(0, 240).map((c) =>
          h(
            "button",
            { type: "button", class: `fd-icon-cell${c === current ? " selected" : ""}`, title: c.slice(prefix.length).replace(/([a-z\d])([A-Z])/g, "$1 $2"), onclick: () => ((chosen = c), p.close()) },
            heroicon(o.dir, c),
          ),
        ),
      );
    };
    search.oninput = render;
    style.onchange = render;
    const p = popover(anchor, h("div", { class: "fd-icons" }, h("div", { class: "fd-icons-bar" }, search, style), grid, h("div", { class: "fd-icons-foot" }, count, h("button", { type: "button", class: "link", textContent: "No icon", onclick: () => ((chosen = ""), p.close()) }))), () => resolve(chosen), "wide");
    render();
    requestAnimationFrame(() => search.focus());
  });
}

// ---- Colors ----

/** Filament's colors as swatches, as the default panel colors them. */
export const COLOR_SWATCH: Record<string, string> = { primary: "#f59e0b", gray: "#71717a", success: "#22c55e", warning: "#f59e0b", danger: "#ef4444", info: "#3b82f6" };

/** Chooses one of Filament's colors, or none. */
export function colorChooser(value: string | null | undefined, set: (color: string | null) => void): HTMLElement {
  const wrap = h("div", { class: "fd-colors", role: "radiogroup" });
  const render = () =>
    wrap.replaceChildren(
      h("button", { type: "button", class: `fd-color none${!value ? " selected" : ""}`, title: "Default", ariaLabel: "Default", onclick: () => ((value = null), render(), set(null)) }),
      ...COLORS.map((c) =>
        h("button", { type: "button", class: `fd-color${value === c ? " selected" : ""}`, title: c, ariaLabel: c, style: `--swatch:${COLOR_SWATCH[c]}`, onclick: () => ((value = c), render(), set(c)) }),
      ),
    );
  render();
  return wrap;
}

// ---- Fields ----

/** A text field that commits on Enter or when it loses focus, not on every key. Escape restores the value. */
export function commitInput(value: string, commit: (v: string) => unknown, o: { placeholder?: string; type?: string; list?: string; multiline?: boolean; className?: string } = {}) {
  const input = o.multiline ? h("textarea", { value, placeholder: o.placeholder ?? "", rows: 2, spellcheck: false, className: o.className ?? "" }) : h("input", { value, placeholder: o.placeholder ?? "", type: o.type ?? "text", spellcheck: false, className: o.className ?? "" });
  if (o.list && input instanceof HTMLInputElement) input.setAttribute("list", o.list);
  let last = value;
  const done = () => {
    if (input.value === last) return;
    last = input.value;
    commit(input.value);
  };
  input.addEventListener("change", done);
  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && !(input instanceof HTMLTextAreaElement && !mod(k))) (e.preventDefault(), input.blur());
    if (k.key === "Escape") ((input.value = last), input.blur());
  });
  return input;
}

/** A switch, as Filament draws toggles. */
export function toggleSwitch(on: boolean, set: (on: boolean) => unknown, label?: string) {
  const box = h("input", { type: "checkbox", checked: on, role: "switch", className: "fd-switch-input", ariaLabel: label ?? "" });
  box.onchange = () => set(box.checked);
  return h("label", { class: "fd-switch" }, box, h("span", { class: "fd-switch-track" }));
}

/** Segmented buttons for a few choices. */
export function segmented<T extends string>(options: [T, string][], value: T, set: (v: T) => unknown, titles: Partial<Record<T, string>> = {}) {
  const wrap = h("div", { class: "fd-segmented", role: "radiogroup" });
  for (const [v, label] of options)
    wrap.append(h("button", { type: "button", class: v === value ? "selected" : "", role: "radio", ariaChecked: String(v === value), title: titles[v] ?? "", textContent: label, onclick: () => v !== value && set(v) }));
  return wrap;
}
