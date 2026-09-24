// A keyboard-driven picker used by go to file, go to class, find in files, and actions.

export type Item = { label: string; detail?: string; run(): unknown };
type Source = (query: string) => Item[] | Promise<Item[]>;

const MAX_ROWS = 200;

/**
 * Scores `text` against `query` as a subsequence match, ignoring case.
 * Returns -1 when `query` doesn't match. Consecutive letters and letters that start
 * a word (after `/`, `\`, `_`, `-`, `.`, a space, or a lowercase-to-uppercase change) score higher.
 */
export function fuzzy(query: string, text: string): number {
  let score = 0;
  let t = 0;
  let prev = -2;
  const lower = text.toLowerCase();
  for (const ch of query.toLowerCase()) {
    if (ch === " ") continue;
    const i = lower.indexOf(ch, t);
    if (i < 0) return -1;
    const boundary = i === 0 || "/\\_-. ".includes(text[i - 1]) || (text[i] !== lower[i] && text[i - 1] === lower[i - 1]);
    score += 1 + (i === prev + 1 ? 5 : 0) + (boundary ? 8 : 0);
    prev = i;
    t = i + 1;
  }
  return score - text.length / 100; // Prefer shorter texts on ties.
}

/** Filters and sorts items by fuzzy score against their label. */
export function rank(query: string, items: Item[]): Item[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: fuzzy(query, item.label) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}

let close: (() => void) | null = null;

/**
 * Opens the picker. `source` runs on every query change, after `delay` ms for slow sources.
 * `initial` prefills the input, optionally selecting part of it (such as a file name without its extension).
 */
export function pick(placeholder: string, source: Source, delay = 0, initial?: { value: string; select?: [number, number] }) {
  close?.();
  const overlay = document.createElement("div");
  overlay.id = "palette";
  const input = document.createElement("input");
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  const list = document.createElement("ul");
  list.role = "listbox";
  overlay.append(input, list);
  document.body.append(overlay);

  let items: Item[] = [];
  let selected = 0;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const previousFocus = document.activeElement as HTMLElement | null;

  const render = () => {
    list.replaceChildren(
      ...items.slice(0, MAX_ROWS).map((item, i) => {
        const li = document.createElement("li");
        li.role = "option";
        li.ariaSelected = String(i === selected);
        li.className = i === selected ? "selected" : "";
        const label = document.createElement("span");
        label.textContent = item.label;
        li.append(label);
        if (item.detail) {
          const detail = document.createElement("span");
          detail.className = "detail";
          detail.textContent = item.detail;
          li.append(detail);
        }
        li.onmousedown = (e) => (e.preventDefault(), choose(i));
        return li;
      }),
    );
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  };

  const update = () => {
    const current = ++generation;
    Promise.resolve(source(input.value)).then((result) => {
      if (current !== generation) return; // A newer query already ran.
      items = result;
      selected = 0;
      render();
    });
  };

  const choose = (i: number) => {
    const item = items[i];
    dismiss(false);
    item?.run();
  };

  const dismiss = (restoreFocus = true) => {
    overlay.remove();
    close = null;
    if (restoreFocus) previousFocus?.focus();
  };
  close = dismiss;

  input.oninput = () => {
    clearTimeout(timer);
    timer = delay ? setTimeout(update, delay) : (update(), undefined);
  };
  input.onkeydown = (e) => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
    if (e.key in moves) {
      selected = Math.max(0, Math.min(Math.min(items.length, MAX_ROWS) - 1, selected + moves[e.key]));
      render();
    } else if (e.key === "Enter") choose(selected);
    else if (e.key === "Escape") dismiss();
    else return;
    e.preventDefault();
  };
  input.onblur = () => dismiss(false);
  input.value = initial?.value ?? "";
  input.focus();
  if (initial?.select) input.setSelectionRange(...initial.select);
  update();
}
