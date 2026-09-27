// The status bar's path, followed by the symbols around the cursor: `app/Models/User.php › User › posts`.
// Symbols come from Monaco's outline service, the one sticky scroll uses, so its cached outline is
// reused and the language servers get no extra requests.
import { monaco } from "./editor";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IOutlineModelService } from "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js";
import { SymbolKinds } from "monaco-editor/editor/common/languages.js";

let pending: monaco.CancellationTokenSource | undefined;

/** The symbols that enclose a position, outermost first. */
async function enclosing(model: monaco.editor.ITextModel, position: monaco.IPosition) {
  pending?.cancel();
  const source = (pending = new monaco.CancellationTokenSource());
  const outline = await StandaloneServices.get(IOutlineModelService).getOrCreate(model, source.token);
  const chain: monaco.languages.DocumentSymbol[] = [];
  for (let level = outline.getTopLevelSymbols(); ; ) {
    const symbol = level.find((s) => monaco.Range.containsPosition(s.range, position));
    if (!symbol) return chain;
    chain.push(symbol);
    level = symbol.children ?? [];
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let drawn = 0;
let version = { model: null as monaco.editor.ITextModel | null, id: 0 };

/**
 * Shows `rel` and the symbols at the editor's cursor in `el`. Clicking a symbol moves the cursor to
 * its name. Cursor moves are debounced, so holding an arrow key doesn't redraw on every line.
 * While you type, it waits longer: a new outline is a request to every language server, and it
 * sends Phpactor the whole file first.
 */
export function showBreadcrumbs(el: HTMLElement, rel: string, editor: monaco.editor.ICodeEditor) {
  clearTimeout(timer);
  const call = ++drawn;
  const model = editor.getModel();
  const draw = (symbols: monaco.languages.DocumentSymbol[]) => {
    const path = document.createElement("span");
    path.className = "crumb-path";
    // Isolated, so the right-to-left box that puts the ellipsis at the start keeps `.env` and the slashes in order.
    path.append(Object.assign(document.createElement("bdi"), { textContent: rel }));
    el.replaceChildren(
      path,
      ...symbols.map((s) => {
        const crumb = document.createElement("button");
        crumb.className = "crumb";
        crumb.innerHTML = `<span class="codicon codicon-${SymbolKinds.toIcon(s.kind).id}"></span><span></span>`;
        crumb.lastElementChild!.textContent = s.name;
        crumb.onclick = () => {
          editor.setPosition(monaco.Range.getStartPosition(s.selectionRange));
          editor.revealRangeInCenterIfOutsideViewport(s.selectionRange);
          editor.focus();
        };
        return crumb;
      }),
    );
  };
  if (!rel || !model) return el.replaceChildren();
  // Keep the last symbols until the new ones arrive, so the bar doesn't flicker.
  if (el.firstElementChild?.textContent !== rel) draw([]);
  const edited = version.model === model && version.id !== model.getVersionId();
  version = { model, id: model.getVersionId() };
  timer = setTimeout(async () => {
    const position = editor.getPosition();
    if (!position || editor.getModel() !== model) return;
    const symbols = await enclosing(model, position).catch(() => null);
    // A later call, such as for another pane, owns the bar now.
    if (symbols && call === drawn) draw(symbols);
  }, edited ? 600 : 100);
}
