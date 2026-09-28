// Replace in Files' preview, as PhpStorm's Preview: every match by file, each line before and after, with a
// checkbox on each file and each match, so you can leave some out before replacing. Space toggles the selected
// row's checkbox, Enter shows the match in the editor, and ⌘⏎ replaces.
import { invoke } from "@tauri-apps/api/core";
import { h, icon } from "./dom";
import { monaco } from "./editor";
import { fileIcon } from "./icons";
import { listNav } from "./listnav";
import { diffLine } from "./refactorpreview";
import type { Replacement } from "./replacedata";
import type { Match, Query } from "./search";
import { errorText, showError } from "./status";
import { closeView, showPanelView } from "./terminal";

type Host = { root(): string; openAt(path: string, range: monaco.IRange): unknown };
let host: Host;
export const initReplacePreview = (h: Host) => (host = h);

export type PreviewOptions = {
  query: Query;
  replacement: string;
  matches: Match[];
  /** The search stopped at its limit, so the preview can't list every match. */
  truncated: boolean;
  /** Replaces in every matching file, without a preview, for results past the limit. */
  replaceEverywhere(): Promise<unknown>;
  /** Applies the kept replacements, by file. */
  apply(files: [path: string, replacements: Replacement[]][]): Promise<unknown>;
};

const panel = h("div", { class: "hierarchy refactor-preview replace-preview" });

/** Shows the preview for a search's matches. */
export async function showReplacePreview(o: PreviewOptions) {
  const relative = (path: string) => (path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path);
  showPanelView("Replace Preview", panel);
  panel.replaceChildren(h("p", { class: "muted replace-note" }, `Working out ${o.matches.length} replacements…`));
  let after: (string | null)[];
  try {
    after = await invoke<(string | null)[]>("replacements", { matches: o.matches.map((m) => [m.text, m.column]), query: o.query, replacement: o.replacement });
  } catch (e) {
    panel.replaceChildren(h("p", { class: "muted replace-note", role: "alert" }, `Couldn't work out the replacements: ${errorText(e)}`));
    return;
  }
  // Matches whose line no longer matches there are left out: the file changed since the search.
  const items = o.matches.map((m, i) => ({ m, text: after[i], kept: after[i] !== null }));
  const files = new Map<string, typeof items>();
  for (const it of items) if (it.text !== null) files.set(it.m.path, [...(files.get(it.m.path) ?? []), it]);

  const replaceButton = h("button", { class: "primary", title: "Replace the checked matches (⌘⏎)" });
  const summary = h("span", { class: "hierarchy-title" });
  const tree = h("ul", { class: "hierarchy-tree", role: "tree", ariaLabel: "Replacements" });
  const update = () => {
    const kept = items.filter((it) => it.kept && it.text !== null);
    const inFiles = new Set(kept.map((it) => it.m.path)).size;
    replaceButton.textContent = `Replace ${kept.length} ${kept.length === 1 ? "Match" : "Matches"}`;
    replaceButton.disabled = !kept.length;
    summary.textContent = `“${o.query.text}” → “${o.replacement}”: ${kept.length} of ${items.length} in ${inFiles} of ${files.size} ${files.size === 1 ? "file" : "files"}`;
    for (const [path, list] of files) {
      const box = tree.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(path)}"] input`);
      if (!box) continue;
      box.checked = list.every((it) => it.kept);
      box.indeterminate = !box.checked && list.some((it) => it.kept);
    }
  };
  const checkbox = (checked: boolean, label: string, onchange: (on: boolean) => void) => {
    const box = h("input", { type: "checkbox", checked, ariaLabel: label, tabIndex: -1 });
    box.onclick = (e) => e.stopPropagation();
    box.onchange = () => (onchange(box.checked), update());
    return box;
  };
  const rows: HTMLElement[] = [];
  for (const [path, list] of files) {
    const name = relative(path).split("/").pop()!;
    const fi = fileIcon(name);
    const fileBox = checkbox(true, `Replace in ${relative(path)}`, (on) => {
      list.forEach((it) => (it.kept = on));
      tree.querySelectorAll<HTMLInputElement>(`[data-path="${CSS.escape(path)}"] input`).forEach((b) => (b.checked = on));
    });
    const head = h(
      "li",
      { class: "hierarchy-row group", role: "treeitem", data: { key: path, label: name } },
      fileBox,
      h("span", { class: `file-icon codicon codicon-${fi.codicon} ${fi.color}` }),
      h("span", { class: "name" }, name),
      h("span", { class: "namespace" }, relative(path).slice(0, -name.length - 1)),
      h("span", { class: "count" }, String(list.length)),
    );
    head.setAttribute("aria-level", "1");
    head.setAttribute("aria-expanded", "true");
    const children: HTMLElement[] = list.map((it, i) => {
      const box = checkbox(true, `Replace on line ${it.m.line}`, (on) => (it.kept = on));
      const before = it.m.text;
      const changed = before.slice(0, it.m.column - 1) + it.text + before.slice(it.m.end - 1);
      const row = h(
        "li",
        { class: "hierarchy-row", role: "treeitem", style: "padding-left: 28px", data: { key: `${path}\n${i}`, path, label: before.trim() } },
        box,
        h("span", { class: "line-number" }, String(it.m.line)),
        diffLine(before.trim(), changed.trim()),
      );
      row.setAttribute("aria-level", "2");
      row.ondblclick = () => host.openAt(path, new monaco.Range(it.m.line, it.m.column, it.m.line, it.m.end));
      return row;
    });
    head.onclick = () => {
      const open = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", String(open));
      children.forEach((c) => (c.hidden = !open));
    };
    rows.push(head, ...children);
  }
  tree.replaceChildren(...rows);
  const nav = listNav(tree, {
    open: (row) => {
      const [path, i] = (row.dataset.key ?? "").split("\n");
      const it = i !== undefined ? files.get(path)?.[Number(i)] : undefined;
      if (it) host.openAt(path, new monaco.Range(it.m.line, it.m.column, it.m.line, it.m.end));
      else row.click();
    },
  });
  tree.addEventListener("keydown", (e) => {
    if (e.target !== tree || e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    nav.selectedRow()?.querySelector<HTMLInputElement>("input")?.click();
  });

  const stale = items.length - items.filter((it) => it.text !== null).length;
  replaceButton.onclick = async () => {
    const kept = [...files].map(([path, list]): [string, Replacement[]] => [
      path,
      list.filter((it) => it.kept).map((it) => ({ line: it.m.line, column: it.m.column, end: it.m.end, text: it.text!, lineText: it.m.text })),
    ]).filter(([, list]) => list.length);
    closeView(panel);
    await o.apply(kept).catch((e) => showError("Replace failed", e));
  };
  panel.replaceChildren(
    h(
      "div",
      { class: "hierarchy-toolbar" },
      replaceButton,
      h("button", { onclick: () => closeView(panel) }, "Cancel"),
      o.truncated ? h("button", { title: "The search stopped at 20,000 matches. Replace in every matching file, without a preview", onclick: () => (closeView(panel), o.replaceEverywhere()) }, "Replace in All Files…") : null,
      summary,
    ),
    o.truncated || stale
      ? h("p", { class: "muted replace-note" }, icon("warning"), [o.truncated ? " The search stopped at 20,000 matches, so this lists only those." : "", stale ? ` ${stale} ${stale === 1 ? "match is" : "matches are"} left out: the file changed since the search.` : ""].join(""))
      : "",
    tree,
  );
  panel.onkeydown = (e) => {
    if (e.key === "Escape") (e.preventDefault(), closeView(panel));
    else if (e.key === "Enter" && e.metaKey) (e.preventDefault(), replaceButton.click());
  };
  update();
  tree.focus();
  const first = tree.querySelector<HTMLElement>("[data-key]");
  if (first) nav.select(first.dataset.key!);
}
