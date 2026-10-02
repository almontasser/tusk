// Enter and Tab in a PHP docblock line, ` * …`. Enter starts the new line with the same `*` and the same spaces after
// it, so the text lines up; Tab counts tab stops from the text after `* `, not from the start of the line.
import { docblockPrefix, tabSpaces } from "./comments.ts";
import { monaco } from "./editor";

type Editor = monaco.editor.IStandaloneCodeEditor;

export function attachDocblocks(ed: Editor) {
  const key = ed.createContextKey<boolean>("tuskDocblock", false);
  /** The prefix and cursor when one empty cursor is past the `*` of a PHP docblock line. */
  const here = () => {
    const model = ed.getModel();
    const selections = ed.getSelections();
    if (model?.getLanguageId() !== "php" || selections?.length !== 1 || !selections[0].isEmpty()) return null;
    const { lineNumber, column } = selections[0].getPosition();
    if (lineNumber === 1) return null;
    const line = model.getLineContent(lineNumber);
    const prefix = docblockPrefix(line, model.getLineContent(lineNumber - 1));
    // Past the `*`, so Enter before it still splits the line as usual.
    if (prefix === null || column - 1 <= line.indexOf("*")) return null;
    return { model, prefix, line, lineNumber, column };
  };
  ed.onDidChangeCursorSelection(() => key.set(!!here()));
  ed.onDidChangeModel(() => key.set(!!here()));
  const insert = (range: monaco.IRange, text: string) => {
    ed.pushUndoStop();
    ed.executeEdits("docblock", [{ range, text, forceMoveMarkers: true }]);
    ed.pushUndoStop();
  };
  const when = "tuskDocblock && editorTextFocus && !editorReadonly && !suggestWidgetVisible && !inlineSuggestionVisible && !inSnippetMode";
  ed.addCommand(monaco.KeyCode.Enter, () => {
    const at = here();
    if (!at) return ed.trigger("keyboard", "type", { text: "\n" });
    // Text after the cursor moves to the new line, after the prefix, without the spaces it started with.
    const end = at.line.slice(at.column - 1).match(/^\s*/)![0].length;
    insert(new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column + end), at.model.getEOL() + at.prefix);
  }, when);
  ed.addCommand(monaco.KeyCode.Tab, () => {
    const at = here();
    const { tabSize, insertSpaces } = ed.getModel()!.getOptions();
    if (!at || !insertSpaces) return ed.trigger("keyboard", "tab", null);
    const start = at.line.indexOf("*") + 2;
    if (at.column - 1 < start) return ed.trigger("keyboard", "tab", null);
    const spaces = " ".repeat(tabSpaces(at.column - 1, start, tabSize));
    insert(new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), spaces);
  }, when);
}
