// Vim emulation through monaco-vim, which loads the first time Vim mode is turned on.
import type { monaco } from "./editor";

type Editor = monaco.editor.ICodeEditor;
/** Each editor's Vim mode and its status bar node, which shows the mode and the `:` command line. */
const modes = new Map<Editor, { node: HTMLElement; vim?: { dispose(): void } }>();

/** Shows the Vim status of the editor you last typed in. */
const show = (node: HTMLElement) => document.querySelectorAll("#vim-status > span").forEach((n) => n.classList.toggle("current", n === node));

/** Turns Vim mode on or off in an editor. */
export async function setVim(ed: Editor, on: boolean) {
  const mode = modes.get(ed);
  if (!on && mode) mode.vim?.dispose(), mode.node.remove(), modes.delete(ed);
  if (!on || mode) return;
  const node = document.createElement("span");
  document.getElementById("vim-status")!.append(node);
  const entry: { node: HTMLElement; vim?: { dispose(): void } } = { node };
  modes.set(ed, entry);
  const { initVimMode } = await import("monaco-vim");
  // Turned off, or the editor closed, while monaco-vim loaded.
  if (modes.get(ed) !== entry) return;
  entry.vim = initVimMode(ed as monaco.editor.IStandaloneCodeEditor, node);
  ed.onDidFocusEditorText(() => modes.get(ed) === entry && show(node));
  if (ed.hasTextFocus() || modes.size === 1) show(node);
}
