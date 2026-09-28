// A keyboard-driven picker used by go to file, go to class, find in files, and actions.
import { errorText } from "./status.ts";

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
  // The query as one block beats letters scattered over word starts ("user" in User.php over
  // tests/Unit/SettingResourceTest.php), and more so in the file name, and at its start.
  const whole = query.toLowerCase().replace(/\s/g, "");
  const at = lower.lastIndexOf(whole);
  if (at >= 0) {
    const name = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\")) + 1;
    score += whole.length * 6 + (at >= name ? 20 : 0) + (at === name ? 20 : 0);
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
 * `onCancel` runs when the picker closes without a choice. With `anchor`, it opens as a dropdown below that element.
 */
/**
 * `title` makes a compact popup, as PhpStorm's refactoring popups: a header instead of a search box, which
 * shows what you type to filter; `numbered` lets 1 to 9 choose a row; `code` sets rows in the editor's font;
 * `question` sets the title as a sentence that wraps.
 */
type Options = { value: string; select?: [number, number]; onCancel?: () => void; anchor?: HTMLElement; title?: string; numbered?: boolean; code?: boolean; question?: boolean };

export function pick(placeholder: string, source: Source, delay = 0, initial?: Options) {
  close?.();
  lowered.clear();
  const overlay = document.createElement("div");
  overlay.id = "palette";
  const input = document.createElement("input");
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  const list = document.createElement("ul");
  list.role = "listbox";
  const header = document.createElement("div");
  header.className = "popup-title";
  if (initial?.title) overlay.append(header);
  overlay.append(input, list);
  const anchor = initial?.anchor?.getBoundingClientRect();
  if (anchor) {
    overlay.className = initial?.title ? "dropdown popup" : "dropdown";
    overlay.style.left = `${anchor.left}px`;
    overlay.style.top = `${anchor.bottom + 4}px`;
  } else if (initial?.title) overlay.className = "popup";
  if (initial?.code) overlay.classList.add("code");
  if (initial?.question) overlay.classList.add("question");
  // A numbered popup is chosen from, so its search box hides; a titled one you type into keeps it.
  if (initial?.numbered) overlay.classList.add("chooser");
  document.body.append(overlay);
  // Kept inside the window: shifted left at the right edge, and above the anchor when there's no room below.
  const place = () => {
    if (!anchor) return;
    const box = overlay.getBoundingClientRect();
    overlay.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8))}px`;
    if (anchor.bottom + 4 + box.height > innerHeight - 8 && anchor.top - 4 - box.height > 8) overlay.style.top = `${anchor.top - 4 - box.height}px`;
  };
  const showTitle = () => {
    if (!initial?.title) return;
    header.replaceChildren(initial.title);
    if (input.value) header.append(Object.assign(document.createElement("span"), { className: "popup-search", textContent: input.value }));
  };

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
        if (initial?.numbered) li.append(Object.assign(document.createElement("span"), { className: "mnemonic", textContent: i < 9 ? String(i + 1) : "" }));
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
    showTitle();
    place();
  };

  const update = () => {
    const current = ++generation;
    // A source that fails shows why in the list, rather than an empty list that reads as "no results".
    const failed = (e: unknown): Item[] => (console.error(placeholder, e), [{ label: "Couldn't load the list", detail: errorText(e), icon: "codicon-error icon-error", run: () => {} }]);
    new Promise<Item[]>((resolve) => resolve(source(input.value))).then(null, failed).then((result) => {
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
    else if (initial?.numbered && !input.value && /^[1-9]$/.test(e.key) && Number(e.key) <= items.length) choose(Number(e.key) - 1);
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
    pick(question, (q) => rank(q, options.map((label) => ({ label, run: () => resolve(label) }))), 0, { value: "", title: question, numbered: true, question: true, onCancel: () => resolve(null) }),
  );

/** Asks a yes-or-no question: `action` confirms, and Cancel or Escape doesn't. */
export const confirm = async (question: string, action: string) => (await choose(question, [action, "Cancel"])) === action;
