// Inline merge conflict resolution: links above each conflict block and colored sides.
import { monaco } from "./editor";
import { type Conflict, parseConflicts } from "./gitparse";

type Choice = "current" | "incoming" | "both";

/** The lines that replace a conflict block for a choice. The base section (diff3 style) is dropped. */
function resolution(lines: string[], c: Conflict, choice: Choice) {
  const current = lines.slice(c.start, (c.base ?? c.separator) - 1);
  const incoming = lines.slice(c.separator, c.end - 1);
  return choice === "current" ? current : choice === "incoming" ? incoming : [...current, ...incoming];
}

function accept(model: monaco.editor.ITextModel, start: number, choice: Choice) {
  const lines = model.getLinesContent();
  const c = parseConflicts(lines).find((x) => x.start === start);
  if (!c) return; // The block changed since the link was drawn.
  const kept = resolution(lines, c, choice);
  // Replace whole lines, including the line break after the closing marker.
  const range =
    c.end < model.getLineCount()
      ? new monaco.Range(c.start, 1, c.end + 1, 1)
      : new monaco.Range(c.start, 1, c.end, model.getLineMaxColumn(c.end));
  const text = kept.length ? kept.join(model.getEOL()) + (c.end < model.getLineCount() ? model.getEOL() : "") : "";
  model.pushEditOperations([], [{ range, text }], () => null);
}

export function initConflicts(editor: monaco.editor.IStandaloneCodeEditor) {
  monaco.editor.registerCommand("conflict.accept", (_, uri: string, start: number, choice: Choice) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) accept(model, start, choice);
  });

  monaco.languages.registerCodeLensProvider("*", {
    provideCodeLenses(model) {
      const lenses = parseConflicts(model.getLinesContent()).flatMap((c) => {
        const range = new monaco.Range(c.start, 1, c.start, 1);
        const lens = (title: string, choice: Choice) => ({ range, command: { id: "conflict.accept", title, arguments: [model.uri.toString(), c.start, choice] } });
        return [
          lens(`Accept Current${c.currentLabel ? ` (${c.currentLabel})` : ""}`, "current"),
          lens(`Accept Incoming${c.incomingLabel ? ` (${c.incomingLabel})` : ""}`, "incoming"),
          lens("Accept Both", "both"),
        ];
      });
      return { lenses, dispose() {} };
    },
  });

  // Color the two sides and dim the marker lines.
  const decorations = editor.createDecorationsCollection();
  const update = () => {
    const model = editor.getModel();
    const conflicts = model ? parseConflicts(model.getLinesContent()) : [];
    const block = (from: number, to: number, className: string) =>
      from <= to ? [{ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className } }] : [];
    decorations.set(
      conflicts.flatMap((c) => [
        ...block(c.start, c.start, "conflict-marker"),
        ...block(c.start + 1, (c.base ?? c.separator) - 1, "conflict-current"),
        ...(c.base ? block(c.base, c.separator - 1, "conflict-base") : []),
        ...block(c.separator, c.separator, "conflict-marker"),
        ...block(c.separator + 1, c.end - 1, "conflict-incoming"),
        ...block(c.end, c.end, "conflict-marker"),
      ]),
    );
  };
  editor.onDidChangeModel(update);
  editor.onDidChangeModelContent(update);
}

/** Whether text still contains a complete conflict block. */
export const hasConflicts = (text: string) => parseConflicts(text.split("\n")).length > 0;
