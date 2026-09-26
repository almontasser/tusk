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

/** Each changed line of a file, before and after, with edits that start on the same line applied together. */
export function changedLines(text: string, edits: L.TextEdit[]): { line: number; before: string; after: string }[] {
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
      return { line: line + 1, before: flat(segment).trim(), after: flat(after).trim() };
    });
}

/** A line with what changed marked: the text both share at the start and end stays plain. */
function diffLine(before: string, after: string) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
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
 * Shows what a refactoring would change: `changes` by file URI, with `texts` the current text of each file.
 * **Do Refactor** runs `apply`.
 */
export function showRefactorPreview(title: string, changes: Record<string, L.TextEdit[]>, texts: Map<string, string>, skipped: Skipped[], apply: () => unknown) {
  const relative = (path: string) => (path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path);
  const count = Object.values(changes).reduce((n, e) => n + e.length, 0);
  const files = Object.keys(changes).length;
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
  if (skipped.length)
    tree.append(
      row(0, [icon("warning"), h("span", { class: "name" }, `Left unchanged (${skipped.length})`)]),
      ...skipped.map((s) => row(1, [h("span", { class: "line-number" }, String(s.line)), h("span", { class: "name" }, relative(s.path)), h("span", { class: "namespace" }, s.reason)], () => host.openAt(s.path, s.line))),
    );
  for (const [uri, edits] of Object.entries(changes)) {
    const path = monaco.Uri.parse(uri).fsPath;
    const lines = changedLines(texts.get(uri) ?? "", edits);
    tree.append(
      row(0, [icon("file-code"), h("span", { class: "name" }, relative(path)), h("span", { class: "namespace" }, `${lines.length} ${lines.length === 1 ? "line" : "lines"}`)]),
      ...lines.map((l) => row(1, [h("span", { class: "line-number" }, String(l.line)), diffLine(l.before, l.after)], () => host.openAt(path, l.line))),
    );
  }
  panel.replaceChildren(
    h("div", { class: "hierarchy-toolbar" }, doRefactor, cancel, h("span", { class: "hierarchy-title" }, `${title}: ${count} ${count === 1 ? "change" : "changes"} in ${files} ${files === 1 ? "file" : "files"}`)),
    tree,
  );
  showPanelView("Refactoring Preview", panel);
  doRefactor.focus();
}

export function initRefactorPreview(given: Host) {
  host = given;
}
