// A model's Access view: the resource designer's Access tab in an editor tab of its own, for models without a
// resource, or opened from the model designer or a policy file. Each change is saved at once, as in the designer.
import type * as L from "vscode-languageserver-protocol";
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { type AccessHost, renderAccessTab } from "./filamentaccess";
import { humanize } from "./filamentcatalog";
import { type Doc, host } from "./filamentdesigner";
import { shortClass } from "./filamentschema";
import { applyWorkspaceEdit } from "./lsp";
import { droppedImports, type Edit, Imports, mergeEdits } from "./phpcode";
import { showError } from "./status";
import { showEditorView } from "./terminal";
import { isAbsolute } from "./platform.ts";

const open = new Map<string, AccessView>();

/** Opens the Access view for a model class. */
export function openAccess(model: string) {
  let v = open.get(model);
  if (!v) open.set(model, (v = new AccessView(model)));
  v.show();
}

class AccessView implements AccessHost {
  el = h("div", { class: "fd-designer" });
  facts: { class: string; columns: { name: string }[] } | null = null;
  info: { model: string; pluralLabel: string | null };
  access: { info: fapp.PolicyInfo; doc: Doc | null } | null = null;
  accessError = "";
  host = host;
  private pending: Promise<unknown> = Promise.resolve();
  private listening = new Set<string>();
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.info = { model, pluralLabel: null };
  }

  get root() {
    return host.root();
  }

  show() {
    showEditorView(`${shortClass(this.model)} · Access`, this.el, "shield", () => open.delete(this.model));
    if (!this.access) void this.loadAccess();
    this.render();
  }

  private loading: Promise<void> | null = null;

  loadAccess(): Promise<void> {
    return (this.loading ??= this.read().finally(() => (this.loading = null)));
  }

  private async read() {
    try {
      const [info, details] = await Promise.all([fapp.policy(this.root, this.model), fapp.model(this.root, this.model).catch(() => null)]);
      this.facts = { class: this.model, columns: details?.columns ?? details?.fillable.map((name) => ({ name })) ?? [] };
      this.access = { info, doc: info.file ? await this.doc(isAbsolute(info.file) ? info.file : `${this.root}/${info.file}`) : null };
      this.accessError = "";
    } catch (e) {
      this.accessError = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  /** A file with its outline, read again whenever it changes in the editor. */
  private async doc(path: string): Promise<Doc> {
    const model = await host.ensureModel(path);
    const text = model.getValue();
    if (!this.listening.has(path)) {
      this.listening.add(path);
      model.onDidChangeContent(() => void this.refresh(path));
    }
    return { path, model, text, outline: await fapp.outlineOf(text, path) };
  }

  private async refresh(path: string) {
    if (!this.el.isConnected || this.access?.doc?.path !== path) return;
    this.access.doc = await this.doc(path);
    this.render();
  }

  reveal(node: { span: [number, number] }, doc: Doc) {
    const p = doc.model.getPositionAt(node.span[0]);
    host.openAt(doc.path, p.lineNumber, p.column);
  }

  /** Applies edits to a file, as the resource designer does: against the text they were computed from, imports added. */
  apply(doc: Doc, build: (imports: Imports, fill: (code: string) => string) => Edit[] | null, message: string) {
    const run = this.pending.then(async () => {
      if (doc.model.getValue() !== doc.text) return this.refresh(doc.path);
      if (doc.outline.errors) return host.status("Fix the syntax errors in the policy first.");
      const imports = new Imports(doc.text, doc.outline);
      const fill = (code: string) => code.replace(/\{\{([\w\\]+)\}\}/g, (_, fqn: string) => imports.name(fqn));
      const edits = build(imports, fill);
      if (!edits?.length) return;
      const added = [...edits, ...imports.edits()];
      const all = mergeEdits([...added, ...droppedImports(doc.text, doc.outline, added)]);
      const pos = (o: number) => {
        const p = doc.model.getPositionAt(o);
        return { line: p.lineNumber - 1, character: p.column - 1 };
      };
      await applyWorkspaceEdit({ changes: { [doc.model.uri.toString()]: all.map((e): L.TextEdit => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })) } });
      host.status(message);
    });
    this.pending = run.catch((e) => showError("Can't change the policy", e));
    return run;
  }

  render() {
    this.el.replaceChildren(
      h(
        "header",
        { class: "fd-header" },
        h("span", { class: "fd-header-icon" }, icon("shield")),
        h("div", { class: "fd-header-titles" }, h("h1", {}, `${humanize(shortClass(this.model))}: access`), h("div", { class: "fd-header-chips" }, h("span", { class: "fd-chip-static", title: this.model }, "Model · ", shortClass(this.model)))),
        h("span", { class: "fd-spacer" }),
        iconButton("refresh", "Read the policy again", () => (fapp.forget([`policy:`]), void this.loadAccess())),
      ),
      h("div", { class: "fd-access-view" }, renderAccessTab(this)),
    );
  }
}
