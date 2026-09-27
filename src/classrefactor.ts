// Pull Members Up and Extract Interface, as in PhpStorm: a dialog to choose the members, with the code they become
// and what they'd break shown as you choose, then edits to the class and its parent, or a new interface file.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import {
  applyEdits,
  cantPull,
  classBody,
  type ClassBody,
  type Edit,
  interfaceCandidates,
  type Member,
  memberLabel,
  needsProtected,
  planExtractInterface,
  planPullUp,
  type Problem,
  pullUpProblems,
  typeNameProblem,
} from "./classparse";
import { h, icon, toast } from "./dom";
import { monaco } from "./editor";
import { applyWorkspaceEdit, typeSymbol } from "./lsp";
import { parseTypeDeclarations, type TypeDeclaration } from "./phptypes";
import { readText } from "./projectfiles";
import { namespaceFor, pathsFor, psr4From } from "./psr4";
import { descendantsOf, textOf } from "./refactor";
import { showRefactorPreview } from "./refactorpreview";

type Host = { root(): string; status(text: string): void; openAt(path: string, line: number): Promise<unknown> };
let host: Host;

const shortName = (fqn: string) => fqn.split("\\").pop()!;
const namespaceOf = (fqn: string) => fqn.split("\\").slice(0, -1).join("\\");
const relative = (path: string) => (path.startsWith(`${host.root()}/`) ? path.slice(host.root().length + 1) : path);

// ---- The class at the caret ----

type Found = { model: monaco.editor.ITextModel; text: string; type: TypeDeclaration; body: ClassBody; member?: Member };

/** The class (or other type) whose declaration holds the caret, or the file's only one; null after saying why. */
function classAtCaret(editor: monaco.editor.ICodeEditor, kinds: TypeDeclaration["kind"][], action: string): Found | null {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position || model.getLanguageId() !== "php") return host.status(`${action} works in PHP files.`), null;
  const text = model.getValue();
  const caret = model.getOffsetAt(position);
  const types = parseTypeDeclarations(text).map((type) => ({ type, body: classBody(text, type.offset) }));
  const lineStart = (offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
  const found = types.find(({ type, body }) => body && caret >= lineStart(type.offset) && caret <= body.close) ?? (types.length === 1 ? types[0] : undefined);
  if (!found?.body) return host.status(`Put the cursor in a class to use ${action}.`), null;
  const { type, body } = found;
  if (!kinds.includes(type.kind)) return host.status(`${action} works on ${kinds.join(" and ")} declarations, and ${shortName(type.fqn)} is ${type.kind === "interface" || type.kind === "enum" ? "an" : "a"} ${type.kind}.`), null;
  const member = body.members.find((m) => !m.promoted && caret >= m.start && caret < m.end);
  return { model, text, type, body: body!, member };
}

/** Where a class is declared: its PSR-4 path when that file exists, or else what Phpactor's index says. */
async function locate(fqn: string): Promise<string | null> {
  const psr4 = psr4From((await readText(`${host.root()}/composer.json`).catch(() => "")) || "{}");
  for (const rel of pathsFor(fqn, psr4)) if (await invoke<boolean>("path_exists", { path: `${host.root()}/${rel}` }).catch(() => false)) return `${host.root()}/${rel}`;
  return (await typeSymbol(fqn).catch(() => undefined))?.path ?? null;
}

// ---- The members dialog ----

type Row = {
  /** Why the member can't be chosen, shown in place of a checkbox. */
  disabled?: string | null;
  badges?: { text: string; title: string; kind?: string }[];
  /** A switch on the row, such as Pull Members Up's "abstract". */
  toggle?: { label: string; title: string; on: boolean; locked?: boolean; set(on: boolean): void };
};

type Evaluation = { title: string; code: string; wholeFile?: boolean; problems: Problem[] };

type DialogSpec = {
  heading: string;
  subject: string;
  fields?: HTMLElement[];
  members: Member[];
  selected: Set<Member>;
  row(m: Member): Row;
  options?: HTMLElement[];
  empty: string;
  evaluate(): Promise<Evaluation>;
};

const ICONS: Record<string, string> = { method: "symbol-method", property: "symbol-field", constant: "symbol-constant" };

/** The PHP code colored as the editor colors it. `code` without `<?php` is colored as if it had one. */
async function colorize(el: HTMLElement, code: string) {
  el.dataset.code = code;
  el.textContent = code;
  const tagged = code.startsWith("<?php");
  const html = await monaco.editor.colorize(tagged ? code : `<?php\n${code}`, "php", {}).catch(() => null);
  if (!html || el.dataset.code !== code) return;
  const box = document.createElement("div");
  box.innerHTML = html;
  if (!tagged) {
    // Drop the `<?php` line that only switched the colorizer into PHP.
    const first = box.querySelector("br");
    if (first) {
      const root = first.parentNode!;
      while (root.firstChild && root.firstChild !== first) root.firstChild.remove();
      first.remove();
    }
  }
  el.replaceChildren(...box.childNodes);
}

/**
 * Opens a dialog to choose members. Resolves with whether to preview first, or null when cancelled. `refresh`
 * redraws the rows and the evaluation after something outside the list changed, such as the target.
 */
function memberDialog(spec: DialogSpec) {
  document.getElementById("members-dialog")?.remove();
  const dialog = h("dialog", { id: "members-dialog", class: "refactor-dialog" });
  const filter = h("input", { type: "search", placeholder: "Filter members", spellcheck: false, ariaLabel: "Filter members" });
  const count = h("span", { class: "members-count" });
  const list = h("div", { class: "members-list", role: "group", ariaLabel: "Members", data: { empty: spec.empty } });
  const codeTitle = h("div", { class: "code-title" });
  const code = h("pre", { class: "code" });
  const problems = h("ul", { class: "dialog-problems", role: "status" });
  const previewButton = h("button", { type: "button", textContent: "Preview" });
  const refactorButton = h("button", { type: "button", class: "primary", textContent: "Refactor" });
  const signatures = new Map<Member, HTMLElement>();

  const enabled = (m: Member) => !spec.row(m).disabled;
  const selectAll = (on: boolean) => {
    for (const m of visible()) if (enabled(m)) on ? spec.selected.add(m) : spec.selected.delete(m);
    refresh();
  };
  const visible = () => {
    const q = filter.value.trim().toLowerCase();
    return spec.members.filter((m) => !q || m.name.toLowerCase().includes(q) || m.signature.toLowerCase().includes(q));
  };

  const renderRows = () => {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".member-row")?.dataset.index;
    list.replaceChildren(
      ...visible().map((m) => {
        const r = spec.row(m);
        if (r.disabled) spec.selected.delete(m);
        const on = spec.selected.has(m);
        const box = h("input", { type: "checkbox", checked: on, disabled: !!r.disabled, ariaLabel: memberLabel(m) });
        box.onchange = () => (box.checked ? spec.selected.add(m) : spec.selected.delete(m), refresh());
        let signature = signatures.get(m);
        if (!signature) {
          signature = h("code", { class: "member-signature" });
          colorize(signature, m.signature);
          signatures.set(m, signature);
        }
        const toggle = r.toggle && on && !r.disabled ? h("label", { class: "member-toggle", title: r.toggle.title }, h("input", { type: "checkbox", checked: r.toggle.on, disabled: !!r.toggle.locked, onchange: (e: Event) => (r.toggle!.set((e.target as HTMLInputElement).checked), refresh()) }), r.toggle.label) : null;
        const row = h(
          "div",
          { class: `member-row${on ? " checked" : ""}${r.disabled ? " disabled" : ""}`, title: r.disabled ?? "", data: { index: String(spec.members.indexOf(m)) } },
          box,
          h("span", { class: `member-icon codicon codicon-${ICONS[m.kind] ?? "symbol-misc"}` }),
          signature,
          ...(r.badges ?? []).map((b) => h("span", { class: `badge ${b.kind ?? ""}`, title: b.title }, b.text)),
          toggle,
          r.disabled ? h("span", { class: "member-reason" }, r.disabled) : null,
        );
        // A click anywhere on the row toggles it, except on its own controls.
        row.onclick = (e) => {
          if (r.disabled || (e.target as HTMLElement).closest("input, label")) return;
          // Focused first, so the redrawn list keeps the focus on this row.
          box.focus();
          box.checked = !box.checked;
          box.onchange!(new Event("change"));
        };
        return row;
      }),
    );
    list.querySelector<HTMLInputElement>(`.member-row[data-index="${focused}"] input`)?.focus();
    const chosen = spec.members.filter((m) => spec.selected.has(m)).length;
    count.textContent = `${chosen} of ${spec.members.filter(enabled).length} selected`;
  };

  let evaluation = 0;
  const evaluate = async () => {
    const current = ++evaluation;
    const e: Evaluation = await spec.evaluate().catch((err) => ({ title: "", code: "", problems: [{ level: "error", text: String(err instanceof Error ? err.message : err) }] }));
    if (current !== evaluation) return;
    codeTitle.textContent = e.title;
    codeTitle.parentElement!.hidden = !e.code;
    colorize(code, e.code);
    problems.replaceChildren(
      ...e.problems.map((p) =>
        h(
          "li",
          { class: p.level },
          icon(p.level === "error" ? "error" : "warning"),
          h("span", {}, p.text),
          p.fix ? h("button", { type: "button", onclick: () => (p.fix!.members.forEach((m) => spec.selected.add(m)), refresh()) }, p.fix.label) : null,
        ),
      ),
    );
    const blocked = e.problems.some((p) => p.level === "error") || !spec.selected.size;
    previewButton.disabled = refactorButton.disabled = blocked;
  };

  const refresh = () => {
    renderRows();
    evaluate();
  };

  // ↑ and ↓ move between rows, Space checks one, ⌘A checks every one shown, and ⏎ refactors.
  list.onkeydown = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const boxes = [...list.querySelectorAll<HTMLInputElement>("input[type=checkbox]:not(:disabled)")].filter((b) => !b.closest(".member-toggle"));
    const i = boxes.indexOf(document.activeElement as HTMLInputElement);
    boxes[Math.max(0, Math.min(boxes.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
  filter.oninput = renderRows;
  filter.onkeydown = (e) => {
    if (e.key === "ArrowDown") (e.preventDefault(), list.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus());
  };

  dialog.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, `${spec.heading} `, h("span", { class: "muted" }, spec.subject)),
      spec.fields?.length ? h("div", { class: "dialog-fields" }, ...spec.fields) : null,
      h(
        "div",
        { class: "members-toolbar" },
        filter,
        h("button", { type: "button", onclick: () => selectAll(true) }, "Select All"),
        h("button", { type: "button", onclick: () => selectAll(false) }, "Select None"),
        count,
      ),
      list,
      spec.options?.length ? h("div", { class: "dialog-options" }, ...spec.options) : null,
      h("div", { class: "code-preview" }, codeTitle, code),
      problems,
      h(
        "div",
        { class: "buttons" },
        h("span", { class: "dialog-hint" }, "↑↓ move · Space selects · ⌘A selects all · ⏎ refactors"),
        h("button", { type: "button", textContent: "Cancel", onclick: () => dialog.close() }),
        previewButton,
        refactorButton,
      ),
    ),
  );
  document.body.append(dialog);
  refresh();

  const done = new Promise<{ preview: boolean } | null>((resolve) => {
    let result: { preview: boolean } | null = null;
    const finish = async (preview: boolean) => {
      // The evaluation may still be running after the last change.
      await evaluate();
      if (refactorButton.disabled) return;
      result = { preview };
      dialog.close();
    };
    previewButton.onclick = () => finish(true);
    refactorButton.onclick = () => finish(false);
    dialog.onkeydown = (e) => {
      const target = e.target as HTMLElement;
      if (e.key === "Enter" && !(target instanceof HTMLButtonElement) && !(target instanceof HTMLSelectElement)) (e.preventDefault(), finish(false));
      else if (e.metaKey && e.key.toLowerCase() === "a" && !(target instanceof HTMLInputElement && target.type !== "checkbox")) (e.preventDefault(), selectAll(true));
    };
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
  });
  dialog.showModal();
  (list.querySelector<HTMLInputElement>(".member-row.checked input") ?? list.querySelector<HTMLInputElement>("input:not(:disabled)") ?? filter).focus();
  return { done, refresh };
}

const field = (label: string, control: HTMLElement, grow = false) => h("label", { class: `field${grow ? " grow" : ""}` }, label, control);

/** Edits as LSP text edits against `text`. */
function textEdits(text: string, edits: Edit[]): L.TextEdit[] {
  const position = (offset: number) => {
    const before = text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return { line, character: offset - (before.lastIndexOf("\n") + 1) };
  };
  return edits.map((e) => ({ range: { start: position(e.start), end: position(e.end) }, newText: e.text }));
}

// ---- Pull Members Up ----

type PullTarget = {
  fqn: string;
  name: string;
  kind: "class" | "interface";
  path?: string;
  text?: string;
  type?: TypeDeclaration;
  body?: ClassBody;
  isAbstract?: boolean;
  /** Why it can't take members, such as a class in vendor. */
  disabled?: string;
};

async function loadTarget(fqn: string, kind: "class" | "interface"): Promise<PullTarget> {
  const base = { fqn, name: shortName(fqn), kind };
  const path = await locate(fqn);
  if (!path) return { ...base, disabled: "not found in the project" };
  if (/\/vendor\//.test(relative(path)) || !path.startsWith(`${host.root()}/`)) return { ...base, path, disabled: "in vendor, read-only" };
  const text = await textOf(path).catch(() => null);
  const type = text === null ? undefined : parseTypeDeclarations(text).find((t) => t.fqn === fqn);
  const body = type && classBody(text!, type.offset);
  if (!type || !body) return { ...base, path, disabled: "its declaration couldn't be read" };
  const isAbstract = /\babstract\s+(?:(?:final|readonly)\s+)*class\s+$/.test(text!.slice(0, type.offset));
  return { fqn, name: shortName(fqn), kind: type.kind === "interface" ? "interface" : "class", path, text: text!, type, body, isAbstract };
}

/** The class's parents, nearest first, up to the first one outside the project, then the interfaces it implements. */
async function pullTargets(type: TypeDeclaration): Promise<PullTarget[]> {
  const targets: PullTarget[] = [];
  const seen = new Set<string>();
  for (let fqn = type.extends[0]; fqn && !seen.has(fqn) && targets.length < 10; ) {
    seen.add(fqn);
    const t = await loadTarget(fqn, "class");
    targets.push(t);
    if (t.disabled || !t.type) break;
    fqn = t.type.extends[0];
  }
  for (const fqn of type.implements) if (!seen.has(fqn)) targets.push(await loadTarget(fqn, "interface"));
  return targets;
}

/**
 * Pull Members Up: moves the chosen members of the class at the caret to a parent class, or declares them in an
 * interface it implements. A method can instead be declared abstract in the parent, keeping its code here.
 */
export async function pullMembersUp(editor: monaco.editor.ICodeEditor) {
  const found = classAtCaret(editor, ["class"], "Pull Members Up");
  if (!found) return;
  const { model, text, type, body } = found;
  const name = shortName(type.fqn);
  if (!type.extends.length && !type.implements.length) return host.status(`${name} has no parent class or interface to pull members up to.`);
  host.status(`Finding ${name}'s parents…`);
  const targets = await pullTargets(type);
  host.status("");
  const usable = targets.filter((t) => !t.disabled);
  if (!usable.length) return host.status(`${name}'s parents and interfaces are all outside the project: ${targets.map((t) => `${t.name} (${t.disabled})`).join(", ")}.`);
  if (model.getValue() !== text) return host.status("The file changed. Run Pull Members Up again.");

  let target = usable[0];
  const members = body.members.filter((m) => m.kind === "method" || m.kind === "property" || m.kind === "constant");
  const selected = new Set<Member>(found.member && !cantPull(found.member, target.kind) ? [found.member] : []);
  const abstract = new Set<Member>();
  const siblings = new Map<string, Promise<{ name: string; methods: Set<string> }[]>>();
  const siblingsOf = (t: PullTarget) => {
    if (!siblings.has(t.fqn))
      siblings.set(
        t.fqn,
        descendantsOf(t.fqn)
          .then((ds) =>
            ds
              .filter((d) => d.type.extends[0] === t.fqn && d.type.fqn !== type.fqn)
              .map((d) => ({ name: shortName(d.type.fqn), methods: new Set((classBody(d.text, d.type.offset)?.members ?? []).filter((m) => m.kind === "method").map((m) => m.name.toLowerCase())) })),
          )
          .catch(() => []),
      );
    return siblings.get(t.fqn)!;
  };

  const select = h("select", { ariaLabel: "Target" });
  for (const t of targets) select.append(new Option(`${t.name}${t.kind === "interface" ? " (interface)" : ""}${t.disabled ? ` — ${t.disabled}` : ""}`, t.fqn, false, t === target));
  [...select.options].forEach((o, i) => (o.disabled = !!targets[i].disabled));
  const where = h("span", { class: "dialog-path" });
  const showWhere = () => (where.textContent = `${target.fqn} · ${relative(target.path!)}`);
  showWhere();

  const plan = (moving: Member[]) =>
    planPullUp({ source: text, body, moving, abstract: new Set([...abstract].filter((m) => moving.includes(m))), target: { source: target.text!, fqn: target.fqn, kind: target.kind, offset: target.type!.offset }, targetBody: target.body! });

  const dialog = memberDialog({
    heading: "Pull Members Up",
    subject: name,
    fields: [field("To", select, true), where],
    members,
    selected,
    empty: `${name} declares no members.`,
    row: (m) => {
      const why = cantPull(m, target.kind);
      if (why) return { disabled: why };
      const moving = members.filter((x) => selected.has(x));
      const badges: Row["badges"] = [];
      if (target.kind === "class" && selected.has(m) && needsProtected(text, moving, body.members).includes(m))
        badges.push({ text: "private → protected", title: `${name} still uses it, which a private member of ${target.name} wouldn't allow`, kind: "protect" });
      if (target.kind === "interface" && m.kind === "method" && selected.has(m)) badges.push({ text: "declaration", title: `${target.name} declares it, and ${name} keeps its code` });
      const toggle =
        target.kind === "class" && m.kind === "method"
          ? { label: "abstract", title: `Declare it abstract in ${target.name}, keeping its code in ${name}`, on: abstract.has(m) || m.isAbstract, locked: m.isAbstract, set: (on: boolean) => (on ? abstract.add(m) : abstract.delete(m)) }
          : undefined;
      return { badges, toggle };
    },
    evaluate: async () => {
      const moving = members.filter((m) => selected.has(m));
      if (!moving.length) return { title: "", code: "", problems: [{ level: "error", text: `Choose the members to pull up to ${target.name}.` }] };
      const edits = plan(moving).target.sort((a, b) => a.start - b.start);
      const imports = edits.filter((e) => /^\s*use\s/.test(e.text)).map((e) => e.text.trim());
      const becomesAbstract = edits.find((e) => /^abstract /.test(e.text));
      const added = edits.filter((e) => !imports.includes(e.text.trim()) && e !== becomesAbstract).map((e) => e.text.replace(/^\n+/, "").replace(/\s+$/, ""));
      const code = [imports.join("\n"), becomesAbstract ? `abstract class ${target.name}` : "", ...added].filter(Boolean).join("\n\n");
      const needsSiblings = target.kind === "class" && moving.some((m) => m.kind === "method" && (abstract.has(m) || m.isAbstract));
      const problems = pullUpProblems({
        source: text,
        sourceName: name,
        members: body.members,
        moving,
        abstract,
        target: { name: target.name, kind: target.kind, members: target.body!.members, isAbstract: !!target.isAbstract },
        siblings: needsSiblings ? await siblingsOf(target) : [],
      });
      return { title: `Adds to ${target.name}`, code, problems };
    },
  });
  select.onchange = () => {
    target = targets.find((t) => t.fqn === select.value)!;
    abstract.clear();
    showWhere();
    dialog.refresh();
  };
  const chosen = await dialog.done;
  editor.focus();
  if (!chosen) return;
  if (model.getValue() !== text || (await textOf(target.path!).catch(() => null)) !== target.text) return host.status("A file changed while the dialog was open. Run Pull Members Up again.");

  const moving = members.filter((m) => selected.has(m));
  const { source: sourceEdits, target: targetEdits } = plan(moving);
  const sourceUri = model.uri.toString();
  const targetUri = monaco.Uri.file(target.path!).toString();
  const changes: Record<string, L.TextEdit[]> = { [targetUri]: textEdits(target.text!, targetEdits) };
  if (sourceEdits.length) changes[sourceUri] = textEdits(text, sourceEdits);
  const texts = new Map([[sourceUri, text], [targetUri, target.text!]]);
  const what = moving.length === 1 ? memberLabel(moving[0]) : `${moving.length} members`;
  const apply = async () => {
    await applyWorkspaceEdit({ changes });
    const files = Object.keys(changes).length;
    host.status(`Pulled ${what} up to ${target.name}.${files > 1 ? " ⌘Z undoes it in both files." : ""}`);
    // The first moved member's line in the target, for Open.
    const first = moving[0];
    const pattern = first.kind === "method" ? `function\\s+&?\\s*${first.name}\\s*\\(` : first.kind === "property" ? `\\$${first.name}\\b` : `\\bconst\\s+(?:\\w+\\s+)?${first.name}\\b`;
    const line = Math.max(1, applyEdits(target.text!, targetEdits).split("\n").findIndex((l) => new RegExp(pattern).test(l)) + 1);
    toast(`Pulled ${what} up to ${target.name}.`, { kind: "info", timeout: 10000, action: { label: `Open ${target.name}`, run: () => host.openAt(target.path!, line) } });
  };
  if (chosen.preview) showRefactorPreview(`Pull Members Up to ${target.name}`, changes, texts, [], apply);
  else await apply();
}

// ---- Extract Interface ----

/** The project's namespaces, from its PHP files and composer.json's PSR-4 map, for the namespace field's suggestions. */
async function projectNamespaces(): Promise<string[]> {
  const psr4 = psr4From((await readText(`${host.root()}/composer.json`).catch(() => "")) || "{}");
  const files = await invoke<string[]>("list_files", { root: host.root() }).catch(() => [] as string[]);
  return [...new Set(files.filter((f) => f.endsWith(".php")).map((f) => namespaceFor(f.replace(/^\//, ""), psr4)).filter((n): n is string => !!n))].sort();
}

/**
 * Extract Interface: a new interface with the chosen public methods and constants of the class at the caret, in the
 * file PSR-4 gives its namespace, and the class implementing it. Constants move to the interface.
 */
export async function extractInterface(editor: monaco.editor.ICodeEditor) {
  const found = classAtCaret(editor, ["class", "enum"], "Extract Interface");
  if (!found) return;
  const { model, text, type, body } = found;
  const name = shortName(type.fqn);
  const candidates = interfaceCandidates(body.members);
  if (!candidates.length) return host.status(`${name} has no public methods or constants to put in an interface.`);
  const psr4 = psr4From((await readText(`${host.root()}/composer.json`).catch(() => "")) || "{}");
  const classDir = model.uri.fsPath.slice(0, model.uri.fsPath.lastIndexOf("/"));

  const nameInput = h("input", { value: `${name}Interface`, spellcheck: false, ariaLabel: "Interface name" });
  const namespaceInput = h("input", { value: namespaceOf(type.fqn), spellcheck: false, ariaLabel: "Namespace" });
  const namespaces = h("datalist", { id: "interface-namespaces" });
  namespaceInput.setAttribute("list", namespaces.id);
  projectNamespaces().then((list) => namespaces.replaceChildren(...list.map((n) => h("option", { value: n }))));
  const where = h("span", { class: "dialog-path" });
  const docs = h("input", { type: "checkbox", checked: true });
  const docsLabel = h("label", { class: "option" }, docs, "Copy docblocks");

  /** The interface's full name and file, or why there's no file for it. */
  const destination = () => {
    const ns = namespaceInput.value.trim().replace(/^\\+|\\+$/g, "");
    const iface = nameInput.value.trim();
    const fqn = ns ? `${ns}\\${iface}` : iface;
    const rel = pathsFor(fqn, psr4)[0];
    // Without a PSR-4 folder for it, the interface goes beside the class, in the class's namespace.
    const path = rel ? `${host.root()}/${rel}` : ns === namespaceOf(type.fqn) ? `${classDir}/${iface}.php` : null;
    return { ns, iface, fqn, path };
  };
  const exists = new Map<string, Promise<boolean>>();
  const fileExists = (path: string) => {
    if (!exists.has(path)) exists.set(path, invoke<boolean>("path_exists", { path }).catch(() => false));
    return exists.get(path)!;
  };

  const selected = new Set(candidates.filter((m) => m.kind === "method"));
  if (found.member && candidates.includes(found.member)) selected.add(found.member);
  const plan = (members: Member[]) => {
    const d = destination();
    return planExtractInterface({ source: text, body, offset: type.offset, fqn: type.fqn, members, name: d.iface, namespace: d.ns, docs: docs.checked });
  };

  const dialog = memberDialog({
    heading: "Extract Interface",
    subject: name,
    fields: [field("Interface name", nameInput), field("Namespace", namespaceInput, true), namespaces, where],
    options: [docsLabel],
    members: candidates,
    selected,
    empty: `${name} has no public methods or constants.`,
    row: (m) => ({
      badges: m.kind === "constant" && selected.has(m) ? [{ text: "moves", title: `The constant moves to the interface, and ${name} gets it from there` }] : [],
    }),
    evaluate: async () => {
      const d = destination();
      where.textContent = d.path ? relative(d.path) : "";
      const problems: Problem[] = [];
      const bad = typeNameProblem(d.iface);
      if (bad) problems.push({ level: "error", text: bad });
      else if (d.ns && !/^[A-Za-z_]\w*(\\[A-Za-z_]\w*)*$/.test(d.ns)) problems.push({ level: "error", text: `${d.ns} isn't a valid namespace.` });
      else if (!d.path) problems.push({ level: "error", text: `No PSR-4 folder in composer.json holds the namespace ${d.ns}. Choose another, or add one.` });
      else if (await fileExists(d.path)) problems.push({ level: "error", text: `${relative(d.path)} already exists.` });
      if (type.implements.some((i) => i.toLowerCase() === d.fqn.toLowerCase())) problems.push({ level: "error", text: `${name} already implements ${d.iface}.` });
      if (d.fqn.toLowerCase() === type.fqn.toLowerCase()) problems.push({ level: "error", text: `The interface needs a name other than the class's.` });
      const moving = candidates.filter((m) => selected.has(m));
      if (!moving.length) problems.push({ level: "error", text: "Choose the members the interface declares." });
      for (const m of moving)
        if (m.kind === "method" && /\(\s*[^)]*\bself\s+[&.]*\$/.test(m.signature))
          problems.push({ level: "warning", text: `${memberLabel(m)} takes self, which in the interface means the interface, so ${name}'s own method must accept any ${d.iface}.` });
      if (bad || !moving.length) return { title: "", code: "", problems };
      return { title: d.path ? `New file ${relative(d.path)}` : "New interface", code: plan(moving).file, wholeFile: true, problems };
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const input of [nameInput, namespaceInput]) input.oninput = () => (clearTimeout(timer), (timer = setTimeout(dialog.refresh, 150)));
  docs.onchange = dialog.refresh;
  nameInput.select();
  nameInput.focus();
  const chosen = await dialog.done;
  editor.focus();
  if (!chosen) return;
  if (model.getValue() !== text) return host.status("The file changed while the dialog was open. Run Extract Interface again.");

  const d = destination();
  const moving = candidates.filter((m) => selected.has(m));
  const { file, source } = plan(moving);
  const uri = monaco.Uri.file(d.path!).toString();
  const sourceUri = model.uri.toString();
  const changes = { [sourceUri]: textEdits(text, source) };
  const apply = async () => {
    if (await invoke<boolean>("path_exists", { path: d.path! })) return host.status(`${relative(d.path!)} already exists.`);
    await applyWorkspaceEdit({
      documentChanges: [
        { kind: "create", uri },
        { textDocument: { uri, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: file }] },
        { textDocument: { uri: sourceUri, version: null }, edits: changes[sourceUri] },
      ],
    });
    host.status(`Extracted ${d.iface} from ${name}. ⌘Z undoes it and removes the file.`);
    toast(`Extracted ${d.iface} from ${name}.`, { kind: "info", timeout: 10000, action: { label: `Open ${d.iface}`, run: () => host.openAt(d.path!, file.split("\n").findIndex((l) => l.startsWith("interface ")) + 1) } });
  };
  if (chosen.preview) showRefactorPreview(`Extract Interface ${d.iface}`, changes, new Map([[sourceUri, text]]), [], apply, { [uri]: file });
  else await apply();
}

export function initClassRefactor(h: Host) {
  host = h;
}
