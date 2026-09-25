// A keyboard-driven picker used by go to file, go to class, find in files, and actions.

/**
 * A palette row. `icon` is codicon and color classes, such as "codicon-file-code icon-php".
 * `preview` runs when the row becomes selected, such as to try a color theme.
 */
export type Item = { label: string; detail?: string; icon?: string; run(): unknown; preview?(): unknown };
type Source = (query: string) => Item[] | Promise<Item[]>;

const MAX_ROWS = 200;

/**
 * Scores `text` against `query` as a subsequence match, ignoring case.
 * Returns -1 when `query` doesn't match. Consecutive letters and letters that start
 * a word (after `/`, `\`, `_`, `-`, `.`, a space, or a lowercase-to-uppercase change) score higher.
 */
export function fuzzy(query: string, text: string, lower = text.toLowerCase()): number {
  let score = 0;
  let t = 0;
  let prev = -2;
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

/** Indexes of `text` that a fuzzy match of `query` uses, for highlighting; empty if it doesn't match. */
export function matchPositions(query: string, text: string): number[] {
  const lower = text.toLowerCase();
  // Prefer the query as one block, and its last occurrence, which is usually in the file name.
  const whole = query.toLowerCase().replace(/\s/g, "");
  const at = whole ? lower.lastIndexOf(whole) : -1;
  if (at >= 0) return [...whole].map((_, i) => at + i);
  const positions: number[] = [];
  let t = 0;
  for (const ch of query.toLowerCase()) {
    if (ch === " ") continue;
    const i = lower.indexOf(ch, t);
    if (i < 0) return [];
    positions.push(i);
    t = i + 1;
  }
  return positions;
}

/**
 * Lowercased labels, so ranking the same list again on the next keystroke (such as Go to File's
 * 30,000 paths) doesn't lowercase every label again. Cleared when a picker opens.
 */
const lowered = new Map<string, string>();
const lowerOf = (text: string) => lowered.get(text) ?? (lowered.set(text, text.toLowerCase()), text.toLowerCase());

/** Filters and sorts items by fuzzy score against their label. */
export function rank(query: string, items: Item[]): Item[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: fuzzy(query, item.label, lowerOf(item.label)) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}

let close: (() => void) | null = null;

/**
 * Opens the picker. `source` runs on every query change, after `delay` ms for slow sources.
 * `initial` prefills the input, optionally selecting part of it (such as a file name without its extension).
 * `onCancel` runs when the picker closes without a choice.
 */
export function pick(placeholder: string, source: Source, delay = 0, initial?: { value: string; select?: [number, number]; onCancel?: () => void }) {
  close?.();
  lowered.clear();
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
        if (item.icon) {
          const icon = document.createElement("span");
          icon.className = `file-icon codicon ${item.icon}`;
          li.append(icon);
        }
        const label = document.createElement("span");
        label.className = "label";
        // Bold the letters the query matched, and dim the folder part of a path.
        const hits = new Set(matchPositions(input.value, item.label));
        const folderEnd = item.label.includes("/") ? item.label.lastIndexOf("/") + 1 : 0;
        let run = "";
        let style = "";
        const flush = () => {
          if (!run) return;
          if (!style) label.append(run);
          else label.append(Object.assign(document.createElement(style === "hit" ? "b" : "span"), { textContent: run, className: style === "dir" ? "dir" : "" }));
          run = "";
        };
        item.label.split("").forEach((ch, i) => {
          const next = hits.has(i) ? "hit" : i < folderEnd ? "dir" : "";
          if (next !== style) (flush(), (style = next));
          run += ch;
        });
        flush();
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
    items[selected]?.preview?.();
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
    dismiss(false, !!item);
    item?.run();
  };

  const dismiss = (restoreFocus = true, chosen = false) => {
    if (!overlay.isConnected) return;
    overlay.remove();
    close = null;
    if (restoreFocus) previousFocus?.focus();
    if (!chosen) initial?.onCancel?.();
  };
  close = dismiss;

  input.oninput = () => {
    clearTimeout(timer);
    timer = delay ? setTimeout(update, delay) : (update(), undefined);
  };
  input.onkeydown = (e) => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
    if (e.key in moves) {
      // Only the two rows whose selection changes are touched, not the whole list.
      const rows = list.children;
      rows[selected]?.classList.remove("selected");
      rows[selected]?.setAttribute("aria-selected", "false");
      selected = Math.max(0, Math.min(Math.min(items.length, MAX_ROWS) - 1, selected + moves[e.key]));
      rows[selected]?.classList.add("selected");
      rows[selected]?.setAttribute("aria-selected", "true");
      rows[selected]?.scrollIntoView({ block: "nearest" });
      items[selected]?.preview?.();
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

/**
 * Asks a question in the picker and returns the chosen option, or null for Escape. Used instead of native
 * dialogs, which a page reload can leave stuck on screen.
 */
export const choose = (question: string, options: string[]) =>
  new Promise<string | null>((resolve) =>
    pick(question, () => options.map((label) => ({ label, run: () => resolve(label) })), 0, { value: "", onCancel: () => resolve(null) }),
  );

/** Asks a yes-or-no question: `action` confirms, and Cancel or Escape doesn't. */
export const confirm = async (question: string, action: string) => (await choose(question, [action, "Cancel"])) === action;
