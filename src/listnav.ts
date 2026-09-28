// Keyboard navigation for lists and trees, as PhpStorm's tool windows have it.
//
//   const nav = listNav(container, { open?, toggle?, onSelect?, label?, rows? });
//
// The container keeps the focus and points at the selected row with aria-activedescendant. Rows are the elements
// matching `rows` (default "[data-key]"); each row's `data-key` names it across redraws, so the selection survives
// when the list renders again (a MutationObserver reapplies it). The helper sets the row's `selected` class,
// aria-selected, and an id when it has none. The container gets tabindex 0 and the `list-nav` class, whose CSS
// draws the focused selection in every theme. Give the container a role (listbox, tree, or grid) and the rows theirs.
//
// Keys, when the container has focus:
//   ↑ ↓            previous or next visible row
//   Home End       first or last row
//   PageUp PageDown  a page up or down
//   Enter          open(row), by default row.click()
//   → ←            in a tree: expand or collapse a row with aria-expanded (toggle(row, expand), by default
//                  row.click()); → on an expanded row goes to its first child, ← on a leaf or collapsed row goes to
//                  its parent, the nearest row above with a lower aria-level
//   letters        select the next row whose label starts with what you typed (type-ahead)
//
// Clicking a row selects it too. Other keys are left to the caller's own keydown handler, such as ⌘C to copy.
//
//   nav.select(key, { scroll })   selects a row by key (scrolls to it unless scroll is false)
//   nav.selected()                the selected row's key, or ""
//   nav.selectedRow()             the selected row's element, when it's on screen
//   nav.refresh()                 reapplies the selection now (it also runs after each redraw on its own)

export type ListNavOptions = {
  /** The rows: elements with a `data-key`. */
  rows?: string;
  /** Enter on a row. By default, clicks it. */
  open?(row: HTMLElement, e: KeyboardEvent): void;
  /** → or ← on a row with aria-expanded. By default, clicks it. */
  toggle?(row: HTMLElement, expand: boolean): void;
  /** After the selection moves to another row, by keyboard, click, or select(). */
  onSelect?(row: HTMLElement): void;
  /** The text type-ahead matches. By default, the row's `data-label`, or its text. */
  label?(row: HTMLElement): string;
};

export type ListNav = {
  select(key: string, options?: { scroll?: boolean }): void;
  selected(): string;
  selectedRow(): HTMLElement | undefined;
  refresh(): void;
};

let ids = 0;

/** The index of the next label that starts with `typed`, from `from` on, wrapping around; -1 when none does. */
export function typeAhead(labels: string[], typed: string, from: number): number {
  const prefix = typed.toLowerCase();
  for (let n = 0; n < labels.length; n++) {
    const i = (from + n) % labels.length;
    if (labels[i].trim().toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

export function listNav(container: HTMLElement, options: ListNavOptions = {}): ListNav {
  const selector = options.rows ?? "[data-key]";
  let key = "";
  let typed = "";
  let typedAt = 0;
  if (container.tabIndex < 0) container.tabIndex = 0;
  container.classList.add("list-nav");

  // Rows inside a collapsed or hidden parent aren't reachable.
  const visible = () => [...container.querySelectorAll<HTMLElement>(selector)].filter((r) => r.getClientRects().length > 0);
  const find = (k: string) => [...container.querySelectorAll<HTMLElement>(selector)].find((r) => r.dataset.key === k);
  const level = (r: HTMLElement) => Number(r.getAttribute("aria-level")) || 1;

  const apply = (scroll: boolean) => {
    let found: HTMLElement | undefined;
    for (const r of container.querySelectorAll<HTMLElement>(selector)) {
      const on = !!key && r.dataset.key === key;
      if (r.classList.contains("selected") !== on) r.classList.toggle("selected", on);
      if (r.getAttribute("aria-selected") !== String(on)) r.setAttribute("aria-selected", String(on));
      if (on) found = r;
    }
    if (found) {
      found.id ||= `list-nav-${++ids}`;
      container.setAttribute("aria-activedescendant", found.id);
      if (scroll) found.scrollIntoView({ block: "nearest" });
    } else container.removeAttribute("aria-activedescendant");
    return found;
  };

  const select = (k: string, { scroll = true } = {}) => {
    const changed = k !== key;
    key = k;
    const row = apply(scroll);
    if (changed && row) options.onSelect?.(row);
  };
  const go = (row: HTMLElement | undefined) => row && select(row.dataset.key!);

  container.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (row && container.contains(row) && row.dataset.key !== undefined) select(row.dataset.key, { scroll: false });
  });

  container.addEventListener("keydown", (e) => {
    if (e.target !== container || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = visible();
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.dataset.key === key);
    const row = rows[i];
    const page = Math.max(1, Math.floor(container.clientHeight / (rows[0].offsetHeight || 22)) - 1);
    const to = (n: number) => go(rows[Math.max(0, Math.min(rows.length - 1, n))]);
    const expanded = row?.getAttribute("aria-expanded");
    switch (e.key) {
      case "ArrowDown":
        to(i < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
        to(i < 0 ? 0 : i - 1);
        break;
      case "Home":
        to(0);
        break;
      case "End":
        to(rows.length - 1);
        break;
      case "PageDown":
        to(i + page);
        break;
      case "PageUp":
        to(i - page);
        break;
      case "Enter":
        if (!row) return;
        options.open ? options.open(row, e) : row.click();
        break;
      case "ArrowRight":
        if (!row || expanded === null) return;
        if (expanded === "true") {
          if (rows[i + 1] && level(rows[i + 1]) > level(row)) go(rows[i + 1]);
        } else options.toggle ? options.toggle(row, true) : row.click();
        break;
      case "ArrowLeft":
        if (!row) return;
        if (expanded === "true") options.toggle ? options.toggle(row, false) : row.click();
        else go(rows.slice(0, i).reverse().find((r) => level(r) < level(row)));
        break;
      default: {
        if (e.key.length !== 1 || (e.key === " " && !typed)) return;
        const now = performance.now();
        typed = now - typedAt > 700 ? e.key : typed + e.key;
        typedAt = now;
        const labels = rows.map((r) => options.label?.(r) ?? r.dataset.label ?? r.textContent ?? "");
        // One letter moves on to the next match; more letters refine the current one.
        const found = typeAhead(labels, typed, typed.length === 1 ? i + 1 : Math.max(0, i));
        if (found >= 0) go(rows[found]);
      }
    }
    e.preventDefault();
    e.stopPropagation();
  });

  // A redraw replaces the rows; the selection follows its key onto the new ones.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => ((queued = false), apply(false)));
  }).observe(container, { childList: true, subtree: true });

  return { select, selected: () => key, selectedRow: () => (key ? find(key) : undefined), refresh: () => void apply(false) };
}
