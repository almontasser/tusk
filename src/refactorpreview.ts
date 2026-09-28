// The Refactoring Preview panel, as PhpStorm and VS Code show one: every line a refactoring would change, by
// file, with the changed part marked, and the places it would leave alone, before you apply it.
import type * as L from "vscode-languageserver-protocol";
import { h, icon } from "./dom";
import { monaco } from "./editor";
import { closeView, showPanelView } from "./terminal";

type Host = { root(): string; openAt(path: string, line: number): Promise<unknown> };
/** A place a refactoring leaves unchanged, and why. `line` is 1-based. */
export type Skipped = { path: string; line: number; reason: string };

let host: Host;
const panel = h("div", { class: "hierarchy refactor-preview" });

const flat = (text: string) => text.replace(/\s*\n\s*/g, " ");

/**
 * Each changed line of a file, before and after, with edits that start on the same line applied together. `delta`
 * is how many lines the change adds (or, below zero, removes), for a change that spans several.
 */
export function changedLines(text: string, edits: L.TextEdit[]): { line: number; before: string; after: string; delta: number }[] {
  const lines = text.split("\n");
  const byLine = new Map<number, L.TextEdit[]>();
  for (const e of edits) byLine.set(e.range.start.line, [...(byLine.get(e.range.start.line) ?? []), e]);
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, group]) => {
      const last = Math.max(...group.map((e) => e.range.end.line));
      const segment = lines.slice(line, last + 1).join("\n");
      // Offsets within the segment, applied from the end so earlier ones stay valid.
      const offset = (p: L.Position) => lines.slice(line, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
      let after = segment;
      for (const e of [...group].sort((a, b) => offset(b.range.start) - offset(a.range.start)))
        after = after.slice(0, offset(e.range.start)) + e.newText + after.slice(offset(e.range.end));
      return { line: line + 1, before: flat(segment).trim(), after: flat(after).trim(), delta: after.split("\n").length - segment.split("\n").length };
    });
}

/** A line with what changed marked: the text both share at the start and end stays plain. */
export function diffLine(before: string, after: string) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // Whole tokens read better than parts of them: `0.1, 3` → `3, 0.1` rather than a stray `3`.
  const boundary = /[\s(),[\]{};]/;
  while (start > 0 && !boundary.test(after[start - 1])) start--;
  while (end > 0 && !boundary.test(after[after.length - end])) end--;
  return h(
    "span",
    { class: "preview-text" },
    after.slice(0, start),
    before.length - end > start && h("del", {}, before.slice(start, before.length - end)),
    after.length - end > start && h("ins", {}, after.slice(start, after.length - end)),
    after.slice(after.length - end),
  );
}

/**
 * Shows what a refactoring would change: `changes` by file URI, with `texts` the current text of each file, and
 * `created` the files it would create, by URI, with their text. **Do Refactor** runs `apply`.
 */
export function showRefactorPreview(title: string, changes: Record<string, L.TextEdit[]>, texts: Map<string, string>, skipped: Skipped[], apply: () => unknown, created: Record<string, string> = {}) {
  const relative = (path: string) => (path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path);
  const count = Object.values(changes).reduce((n, e) => n + e.length, 0) + Object.keys(created).length;
  const files = Object.keys(changes).length + Object.keys(created).length;
  const doRefactor = h("button", { class: "primary", textContent: "Do Refactor" });
  const cancel = h("button", { textContent: "Cancel", onclick: () => closeView(panel) });
  doRefactor.onclick = () => {
    closeView(panel);
    apply();
  };
  const row = (depth: number, content: Node[], onclick?: () => unknown) => {
    const div = h("div", { class: "hierarchy-row", style: `padding-left: ${8 + depth * 16}px` }, ...content);
    if (onclick) div.onclick = () => onclick();
    return div;
  };
  const tree = h("div", { class: "hierarchy-tree" });
  /** A group with a header that folds its rows, as the Find tool window's files do. */
  const group = (header: Node[], children: HTMLElement[]) => {
    const chevron = icon("chevron-down");
    chevron.classList.add("chevron");
    const head = row(0, [chevron, ...header], () => {
      const open = chevron.classList.toggle("codicon-chevron-down");
      chevron.classList.toggle("codicon-chevron-right", !open);
      children.forEach((c) => (c.hidden = !open));
    });
    head.classList.add("group");
    tree.append(head, ...children);
  };
  if (skipped.length)
    group(
      [icon("warning"), h("span", { class: "name" }, "Left unchanged"), h("span", { class: "namespace" }, String(skipped.length))],
      skipped.map((s) => row(1, [h("span", { class: "line-number" }, String(s.line)), h("span", { class: "name" }, relative(s.path)), h("span", { class: "reason" }, s.reason)], () => host.openAt(s.path, s.line))),
    );
  const fileHeader = (path: string, iconName: string, count: number, label?: string) => {
    const slash = relative(path).lastIndexOf("/");
    return [
      icon(iconName),
      h("span", { class: "name" }, relative(path).slice(slash + 1)),
      label ? h("span", { class: "badge new-file" }, label) : null,
      h("span", { class: "namespace" }, slash > 0 ? relative(path).slice(0, slash) : ""),
      h("span", { class: "count" }, String(count)),
    ].filter((n): n is HTMLElement => !!n);
  };
  for (const [uri, text] of Object.entries(created)) {
    const path = monaco.Uri.parse(uri).fsPath;
    const lines = text.replace(/\n$/, "").split("\n");
    group(
      fileHeader(path, "new-file", lines.length, "new file"),
      lines.map((l, i) => row(1, [h("span", { class: "line-number" }, String(i + 1)), h("span", { class: "preview-text" }, l.trim() ? h("ins", {}, l) : "")])),
    );
  }
  for (const [uri, edits] of Object.entries(changes)) {
    const path = monaco.Uri.parse(uri).fsPath;
    const lines = changedLines(texts.get(uri) ?? "", edits);
    group(
      fileHeader(path, "file-code", lines.length),
      lines.map((l) =>
        row(1, [
          h("span", { class: "line-number" }, String(l.line)),
          diffLine(l.before, l.after),
          l.delta ? h("span", { class: `line-delta ${l.delta > 0 ? "added" : "removed"}` }, `${l.delta > 0 ? "+" : "−"}${Math.abs(l.delta)} ${Math.abs(l.delta) === 1 ? "line" : "lines"}`) : null,
        ].filter((n): n is HTMLElement => !!n), () => host.openAt(path, l.line)),
      ),
    );
  }
  panel.replaceChildren(
    h(
      "div",
      { class: "hierarchy-toolbar" },
      doRefactor,
      cancel,
      h("span", { class: "preview-title" }, title),
      h("span", { class: "hierarchy-title" }, `${count} ${count === 1 ? "change" : "changes"} in ${files} ${files === 1 ? "file" : "files"}${skipped.length ? `, ${skipped.length} left unchanged` : ""}`),
    ),
    tree,
  );
  panel.onkeydown = (e) => {
    if (e.key === "Escape") (e.preventDefault(), closeView(panel));
  };
  showPanelView("Refactoring Preview", panel);
  doRefactor.focus();
}

export function initRefactorPreview(given: Host) {
  host = given;
}
