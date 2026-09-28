// Edits to PHP files for the designers that change several files, or one file without the resource designer:
// each file's edits are computed from its current text and outline, with classes named through its imports, and
// all files change in one workspace edit, so open editors and local history stay in step. Changes run one at a
// time, so none is computed from code about to change.
import type * as L from "vscode-languageserver-protocol";
import * as fapp from "./filamentapp";
import { host } from "./filamentdesigner";
import { applyWorkspaceEdit } from "./lsp";
import { droppedImports, type Edit, Imports, mergeEdits, type Outline } from "./phpcode";
import { showError } from "./status";

/** A file's edits, from its text and outline; `fill` turns `{{Fqn}}` into the class's name there, importing it. */
export type FileBuild = (text: string, outline: Outline, fill: (code: string) => string) => Edit[] | null;

let pending: Promise<unknown> = Promise.resolve();

/** Applies edits to files and says `message`. Resolves to whether anything changed. */
export function editFiles(files: { path: string; build: FileBuild }[], message: string): Promise<boolean> {
  const run = pending.then(async () => {
    const changes: Record<string, L.TextEdit[]> = {};
    for (const f of files) {
      const model = await host.ensureModel(f.path);
      const text = model.getValue();
      const outline = await fapp.outlineOf(text, f.path);
      if (outline.errors) throw new Error(`Fix the syntax errors in ${f.path.split("/").pop()} first.`);
      const imports = new Imports(text, outline);
      const fill = (code: string) => code.replace(/\{\{([\w\\]+)\}\}/g, (_, fqn: string) => imports.name(fqn));
      const edits = (f.build(text, outline, fill) ?? []).map((e) => ({ ...e, text: fill(e.text) }));
      if (!edits.length) continue;
      const added = [...edits, ...imports.edits()];
      const all = mergeEdits([...added, ...droppedImports(text, outline, added)]);
      const pos = (o: number) => {
        const p = model.getPositionAt(o);
        return { line: p.lineNumber - 1, character: p.column - 1 };
      };
      changes[model.uri.toString()] = all.map((e) => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text }));
    }
    if (!Object.keys(changes).length) return false;
    await applyWorkspaceEdit({ changes });
    host.status(message);
    return true;
  });
  pending = run.catch((e) => showError("Can't change the code", e));
  return run.catch(() => false);
}
