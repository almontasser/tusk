// The Breakpoints tab: every line breakpoint by file, with its code, and the exception breakpoints, as PhpStorm's
// View Breakpoints dialog has them. The tree is on the left and the selected item's options are on the right, where
// they apply as you change them. debug.ts owns the breakpoints; this view reads and changes them through `Api`.
import { invoke } from "@tauri-apps/api/core";
import type { BreakpointOptions, ExceptionOptions } from "./debug";
import { h, icon } from "./dom";
import { monaco } from "./editor";
import { listNav } from "./listnav";
import type { Item } from "./palette";
import { projectRelative } from "./projectstatedata";
import { splitter } from "./splitter";
import { showPanelView } from "./terminal";

type Api = {
  root(): string;
  /** Files with breakpoints, sorted, each with its breakpoints by line. */
  list(): [path: string, breakpoints: [line: number, options: BreakpointOptions][]][];
  /** Sets a breakpoint's options, or removes it with null. */
  set(path: string, line: number, options: BreakpointOptions | null): void;
  /** Changes every breakpoint in a file. */
  setAll(path: string, change: (o: BreakpointOptions) => BreakpointOptions): void;
  /** Removes a file's breakpoints, or after a confirmation, all of them. */
  removeAll(path?: string): unknown;
  openAt(path: string, line: number): Promise<unknown>;
  exceptions(): ExceptionOptions;
  setExceptions(change: ExceptionOptions): void;
  /** The palette item that shares the exception options in tusk.json, or stops sharing them. */
  share(): Item;
  setClasses(): void;
  setSkipped(): void;
};

const EXCEPTIONS = "exceptions";
const LINES = "lines";
const fileKey = (path: string) => `file:${path}`;
const lineKey = (path: string, line: number) => `line:${line}:${path}`;

export function breakpointsView(api: Api) {
  const tree = h("ul", { class: "bp-tree", role: "tree", ariaLabel: "Breakpoints" });
  const detail = h("div", { class: "bp-detail" });
  const remove = h("button", { title: "Remove the selected breakpoint (Delete)", ariaLabel: "Remove" }, icon("remove"));
  const removeAll = h("button", { title: "Remove all breakpoints", ariaLabel: "Remove all breakpoints", onclick: () => api.removeAll() }, icon("close-all"));
  const source = h("button", { title: "Go to the selected breakpoint's line (F4)", ariaLabel: "Go to source" }, icon("go-to-file"));
  const splitHandle = h("div", { class: "pane-splitter" });
  const el = h(
    "div",
    { class: "bp-view" },
    h("div", { class: "debug-toolbar", role: "toolbar", ariaLabel: "Breakpoints" }, source, remove, removeAll),
    h("div", { class: "bp-body" }, tree, splitHandle, detail),
  );
  splitter(splitHandle, { target: tree, axis: "x", edge: "end", label: "Resize the breakpoint list", min: 180, minRest: 220, save: "debug.breakpoints" });

  /** Folded rows, by key. */
  const folded = new Set<string>();
  /** Each file's lines, for files that aren't open, read once each time the tab shows. */
  const code = new Map<string, string[] | null>();

  function lineText(path: string, line: number): string {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) return line <= model.getLineCount() ? model.getLineContent(line).trim() : "";
    if (!code.has(path)) {
      code.set(path, null);
      invoke<string>("read_file", { path }).then(
        (text) => (code.set(path, text.split("\n")), refresh()),
        () => code.set(path, []),
      );
    }
    return code.get(path)?.[line - 1]?.trim() ?? "";
  }

  const row = (key: string, level: number, label: string, ...children: (Node | string | false | undefined)[]) => {
    const r = h("li", { role: "treeitem", data: { key, label } }, ...children);
    r.setAttribute("aria-level", String(level));
    r.style.paddingLeft = `${6 + (level - 1) * 16}px`;
    return r;
  };
  const twisty = (r: HTMLElement, key: string) => {
    r.setAttribute("aria-expanded", String(!folded.has(key)));
    r.prepend(h("span", { class: `codicon codicon-chevron-${folded.has(key) ? "right" : "down"} bp-twisty` }));
    r.onclick = (e) => {
      if ((e.target as HTMLElement).closest(".bp-twisty")) toggle(r);
    };
    r.ondblclick = () => toggle(r);
    return r;
  };
  const checkbox = (checked: boolean, label: string, change: (on: boolean) => void, mixed = false) => {
    const box = h("input", { type: "checkbox", checked, indeterminate: mixed, tabIndex: -1, ariaLabel: label, onchange: () => change(box.checked) });
    box.onclick = (e) => e.stopPropagation();
    return box;
  };
  const glyph = (o: BreakpointOptions) => h("span", { class: `bp-glyph breakpoint${o.logMessage ? " log" : o.condition || o.hitCondition ? " conditional" : ""}${o.disabled ? " disabled" : ""}` });

  function exceptionSummary(o = api.exceptions()) {
    const classes = o.classes?.length ? o.classes.join(", ") : "every exception and error";
    return `${classes}${o.uncaughtOnly ? ", only uncaught" : ""}${o.skip?.length ? `, not thrown in ${o.skip.join(", ")}` : ""}`;
  }

  function render() {
    const files = api.list();
    const count = files.reduce((n, [, list]) => n + list.length, 0);
    const rows: HTMLElement[] = [twisty(row(LINES, 1, "Line Breakpoints", h("span", { class: "bp-group" }, "Line Breakpoints"), h("span", { class: "bp-faint" }, String(count))), LINES)];
    if (!files.length && !folded.has(LINES)) rows.push(h("li", { class: "bp-note" }, "No breakpoints. Click the gutter left of a line, or press ⌘F8, to add one."));
    if (!folded.has(LINES))
      for (const [path, list] of files) {
        const rel = projectRelative(api.root(), path);
        const name = rel.slice(rel.lastIndexOf("/") + 1);
        const enabled = list.filter(([, o]) => !o.disabled).length;
        rows.push(
          twisty(
            row(
              fileKey(path),
              2,
              name,
              checkbox(enabled > 0, `Enable the breakpoints in ${rel}`, (on) => api.setAll(path, (o) => ({ ...o, disabled: on ? undefined : true })), enabled > 0 && enabled < list.length),
              h("span", { class: "codicon codicon-file bp-icon" }),
              h("span", { class: "bp-name" }, name),
              h("span", { class: "bp-faint bp-dir" }, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""),
              h("span", { class: "bp-faint" }, String(list.length)),
            ),
            fileKey(path),
          ),
        );
        if (folded.has(fileKey(path))) continue;
        for (const [line, o] of list) {
          const extra = [o.condition && `if ${o.condition}`, o.hitCondition && `hit ${o.hitCondition}`, o.logMessage && `log ${o.logMessage}`].filter(Boolean).join(" · ");
          const r = row(
            lineKey(path, line),
            3,
            `${line} ${lineText(path, line)}`,
            checkbox(!o.disabled, `Enable the breakpoint on line ${line}`, (on) => api.set(path, line, { ...o, disabled: on ? undefined : true })),
            glyph(o),
            h("span", { class: "bp-line" }, String(line)),
            h("code", { class: "bp-code" }, lineText(path, line)),
            extra && h("span", { class: "bp-faint bp-extra" }, extra),
          );
          r.title = `${rel}:${line}${extra ? `\n${extra}` : ""}\nEnter goes to the line, Space turns it on or off, Delete removes it.`;
          r.ondblclick = () => api.openAt(path, line);
          rows.push(r);
        }
      }
    const ex = api.exceptions();
    rows.push(twisty(row(EXCEPTIONS + "-group", 1, "Exception Breakpoints", h("span", { class: "bp-group" }, "Exception Breakpoints")), EXCEPTIONS + "-group"));
    if (!folded.has(EXCEPTIONS + "-group"))
      rows.push(
        row(
          EXCEPTIONS,
          2,
          "Pause on exceptions",
          checkbox(!!ex.pause, "Pause on exceptions", (on) => api.setExceptions({ pause: on })),
          h("span", { class: "codicon codicon-zap bp-icon" }),
          h("span", {}, "Pause on exceptions"),
          h("span", { class: "bp-faint bp-extra" }, exceptionSummary(ex)),
        ),
      );
    tree.replaceChildren(...rows);
    removeAll.disabled = !count;
    const selected = nav.selected();
    // A selection that's gone, such as a removed breakpoint, moves to what took its place.
    if (!tree.querySelector(`[data-key="${CSS.escape(selected)}"]`)) nav.select(rows[Math.min(lastIndex, rows.length - 1)]?.dataset.key ?? LINES, { scroll: false });
    else if (!detail.contains(document.activeElement)) renderDetail();
    lastIndex = Math.max(0, rows.findIndex((r) => r.dataset.key === nav.selected()));
  }
  let lastIndex = 0;

  function toggle(r: HTMLElement) {
    const key = r.dataset.key!;
    folded.has(key) ? folded.delete(key) : folded.add(key);
    render();
  }

  /** The selected line breakpoint, file, or neither. */
  function selection(): { path: string; line?: number; options?: BreakpointOptions } | null {
    const key = nav.selected();
    if (key.startsWith("file:")) return { path: key.slice(5) };
    const m = /^line:(\d+):(.*)$/.exec(key);
    if (!m) return null;
    const [path, line] = [m[2], Number(m[1])];
    return { path, line, options: api.list().find(([p]) => p === path)?.[1].find(([l]) => l === line)?.[1] };
  }

  const field = (label: string, value: string, placeholder: string, help: string, save: (v: string) => void) => {
    const input = h("input", { value, placeholder, spellcheck: false, ariaLabel: label });
    input.onchange = () => save(input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") (input.value = value), e.stopPropagation(), tree.focus();
    };
    return h("label", { class: "bp-field" }, h("span", {}, label), input, h("small", {}, help));
  };

  function renderDetail() {
    const key = nav.selected();
    const s = selection();
    remove.disabled = !s;
    source.disabled = !s?.line;
    if (key === EXCEPTIONS || key === EXCEPTIONS + "-group") {
      const o = api.exceptions();
      const when = (uncaught: boolean, label: string, help: string) =>
        h("label", { class: "bp-radio" }, h("input", { type: "radio", name: "bp-when", checked: !!o.uncaughtOnly === uncaught, onchange: () => api.setExceptions({ uncaughtOnly: uncaught }) }), h("span", {}, label, h("small", {}, help)));
      const share = api.share();
      detail.replaceChildren(
        h("h3", {}, "Exception breakpoints"),
        h("label", { class: "bp-check" }, h("input", { type: "checkbox", checked: !!o.pause, onchange: (e: Event) => api.setExceptions({ pause: (e.target as HTMLInputElement).checked }) }), "Pause on exceptions"),
        field("Classes", (o.classes ?? []).join(", "), "Every exception and error", "Separate classes with commas, such as App\\Exceptions\\PaymentFailed. Subclasses count too.", (v) =>
          api.setExceptions({ classes: v.split(",").map((c) => c.trim().replace(/^\\/, "")).filter(Boolean) }),
        ),
        h(
          "fieldset",
          { class: "bp-when" },
          h("legend", {}, "Pause"),
          when(false, "Wherever one is thrown, caught or not", "Xdebug pauses at the throw."),
          when(true, "Only when nobody catches it", "In Laravel, when its handler starts rendering the exception; elsewhere, at PHP's fatal error."),
        ),
        field("Skip exceptions thrown in", (o.skip ?? []).join(", "), "Nothing", "Path patterns relative to the project, separated by commas, such as vendor/**.", (v) =>
          api.setExceptions({ skip: v.split(",").map((p) => p.trim()).filter(Boolean) }),
        ),
        h("div", { class: "bp-actions" }, h("button", { title: share.detail, onclick: () => Promise.resolve(share.run()).then(renderDetail) }, share.label)),
      );
    } else if (s?.line && s.options) {
      const { path, line, options: o } = s;
      const set = (change: BreakpointOptions) => api.set(path, line, { ...o, ...change });
      detail.replaceChildren(
        h("h3", {}, `${projectRelative(api.root(), path)}:${line}`),
        h("code", { class: "bp-preview" }, lineText(path, line)),
        h("label", { class: "bp-check" }, h("input", { type: "checkbox", checked: !o.disabled, onchange: (e: Event) => set({ disabled: (e.target as HTMLInputElement).checked ? undefined : true }) }), "Enabled"),
        field("Condition", o.condition ?? "", "Always", "A PHP expression; pauses only when it's true, such as $user->id === 5.", (v) => set({ condition: v || undefined })),
        field("Hit count", o.hitCondition ?? "", "Every hit", "5 pauses the fifth time, >= 5 from the fifth time on, and % 3 every third time.", (v) => set({ hitCondition: v || undefined })),
        field("Log message", o.logMessage ?? "", "Pause instead", "Logs to the Debug tab without pausing. Put expressions in braces, such as Saving {$post->id}.", (v) => set({ logMessage: v || undefined })),
        h("div", { class: "bp-actions" }, h("button", { onclick: () => api.openAt(path, line) }, "Go to Source"), h("button", { onclick: () => api.set(path, line, null) }, "Remove")),
      );
    } else if (s) {
      const list = api.list().find(([p]) => p === s.path)?.[1] ?? [];
      detail.replaceChildren(
        h("h3", {}, projectRelative(api.root(), s.path)),
        h("p", {}, `${list.length} ${list.length === 1 ? "breakpoint" : "breakpoints"}, ${list.filter(([, o]) => !o.disabled).length} enabled.`),
        h(
          "div",
          { class: "bp-actions" },
          h("button", { onclick: () => api.setAll(s.path, (o) => ({ ...o, disabled: undefined })) }, "Enable All"),
          h("button", { onclick: () => api.setAll(s.path, (o) => ({ ...o, disabled: true })) }, "Disable All"),
          h("button", { onclick: () => api.removeAll(s.path) }, "Remove All in File"),
        ),
      );
    } else {
      detail.replaceChildren(h("p", { class: "bp-faint" }, "Select a breakpoint to change its condition, hit count, or log message. Select Pause on exceptions for the exception options."));
    }
  }

  const nav = listNav(tree, {
    open: (r) => {
      const s = selection();
      if (s?.line) api.openAt(s.path, s.line);
      else if (r.getAttribute("aria-expanded") !== null) toggle(r);
    },
    toggle: (r) => toggle(r),
    onSelect: () => renderDetail(),
  });

  function removeSelected() {
    const s = selection();
    if (s?.line) api.set(s.path, s.line, null);
    else if (s) api.removeAll(s.path);
  }
  remove.onclick = removeSelected;
  source.onclick = () => {
    const s = selection();
    if (s?.line) api.openAt(s.path, s.line);
  };

  tree.addEventListener("keydown", (e) => {
    if (e.target !== tree) return;
    const r = nav.selectedRow();
    if (e.key === " " && r) r.querySelector<HTMLInputElement>("input[type=checkbox]")?.click();
    else if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (e.key === "F4") source.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  /** Whether the tab is open, so changes elsewhere, such as in the gutter, show in it at once. */
  let open = false;
  function refresh() {
    if (open) render();
  }

  return {
    refresh,
    /** Shows the tab, selecting a breakpoint or the exception options. */
    show(select: { path?: string; line?: number; exceptions?: boolean } = {}) {
      code.clear();
      showPanelView("Breakpoints", el, () => (open = false));
      open = true;
      if (select.exceptions) folded.delete(EXCEPTIONS + "-group");
      if (select.path) folded.delete(LINES), folded.delete(fileKey(select.path));
      render();
      if (select.exceptions) nav.select(EXCEPTIONS);
      else if (select.path && select.line) nav.select(lineKey(select.path, select.line));
      renderDetail();
      tree.focus();
    },
  };
}
