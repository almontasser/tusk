// Go to Super Method (⌘U) and the gutter icons for methods that override or implement one, or that a subclass
// overrides. Tusk's server lists a file's classes and methods with both (`tusk/overrides`).
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { tuskRequest } from "./lsp";
import { pickAtCaret } from "./extract";
import { showMenu } from "./files";

type Super = { label: string; location: L.Location };
type Member = { kind: "method" | "class"; name: string; range: L.Range; selection: L.Range; supers: Super[]; implements: boolean; abstract: boolean; overridden: boolean };

let host: { status(text: string): void; openAt(path: string, position: monaco.IPosition): unknown };

const membersOf = (model: monaco.editor.ITextModel) => tuskRequest<Member[]>("tusk/overrides", { textDocument: { uri: model.uri.toString() } });
const contains = (r: L.Range, line: number, character: number) =>
  (r.start.line < line || (r.start.line === line && r.start.character <= character)) && (line < r.end.line || (line === r.end.line && character <= r.end.character));
const size = (r: L.Range) => (r.end.line - r.start.line) * 1e6 + r.end.character - r.start.character;

function open(editor: monaco.editor.ICodeEditor, member: Member) {
  const go = (s: Super) => host.openAt(monaco.Uri.parse(s.location.uri).fsPath, { lineNumber: s.location.range.start.line + 1, column: s.location.range.start.character + 1 });
  if (member.supers.length === 1) return go(member.supers[0]);
  const title = member.kind === "method" ? `Super methods of ${member.name}` : `Supertypes of ${member.name}`;
  const items = member.supers.map((s) => ({ label: s.label, detail: monaco.Uri.parse(s.location.uri).fsPath.split("/").pop(), icon: `codicon-symbol-${member.kind}`, run: () => go(s) }));
  pickAtCaret(editor, title, items);
}

/** The method the caret is on or in, else the class: goes to what it overrides or implements, or to its parent class. */
export async function goToSuperMethod(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Go to Super Method works in PHP files.");
  let members: Member[] | null;
  try {
    members = await membersOf(model);
  } catch (e) {
    return host.status(`Couldn't find the super method: ${e}`);
  }
  if (!members) return host.status("Go to Super Method needs Tusk's PHP server, which isn't running.");
  const [member] = members.filter((m) => contains(m.range, pos.lineNumber - 1, pos.column - 1)).sort((a, b) => size(a.range) - size(b.range));
  if (!member) return host.status("Put the caret in a class or a method.");
  if (!member.supers.length)
    return host.status(member.kind === "method" ? `${member.name} doesn't override or implement a method.` : `${member.name} has no parent class or interface.`);
  open(editor, member);
}

// ---- Gutter icons ----

const gutters = new WeakMap<monaco.editor.ICodeEditor, { ids: monaco.editor.IEditorDecorationsCollection; members: Member[] }>();

function hover(m: Member) {
  const up = m.supers.length ? `${m.implements ? "Implements" : "Overrides"} ${m.supers.map((s) => `\`${s.label}\``).join(", ")}` : "";
  const down = !m.overridden ? "" : m.abstract ? "Has implementations" : m.kind === "class" ? "Has subclasses" : "Is overridden";
  return [up, down].filter(Boolean).join(". ") + ". Click to go there.";
}

async function decorate(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const gutter = gutters.get(editor)!;
  if (!model || model.getLanguageId() !== "php" || model.uri.scheme !== "file") return gutter.ids.clear(), (gutter.members = []);
  // The gutter is a hint: when the server can't answer, it shows nothing, and ⌘U reports the problem.
  const members = (await membersOf(model).catch(() => null)) ?? [];
  if (editor.getModel() !== model) return;
  // A class shows only that it's extended; which classes it extends is on its declaration line already.
  const shown = members.filter((m) => (m.kind === "method" && m.supers.length) || m.overridden);
  gutter.members = shown;
  gutter.ids.set(
    shown.map((m) => {
      const up = m.kind === "method" && m.supers.length > 0;
      return {
        range: new monaco.Range(m.selection.start.line + 1, 1, m.selection.start.line + 1, 1),
        options: {
          glyphMarginClassName: `codicon codicon-arrow-circle-${up ? "up" : "down"} super-method${(up ? m.implements : m.abstract) ? " implements" : ""}`,
          glyphMarginHoverMessage: { value: hover(m) },
          glyphMargin: { position: monaco.editor.GlyphMarginLane.Right },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    }),
  );
}

/** Shows the icons in an editor's gutter, and goes to the super method or the implementations when you click one. */
export function attachSuperMethods(editor: monaco.editor.ICodeEditor) {
  gutters.set(editor, { ids: editor.createDecorationsCollection(), members: [] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = (ms: number) => (clearTimeout(timer), (timer = setTimeout(() => decorate(editor), ms)));
  editor.onDidChangeModel(() => soon(0));
  // Tusk's server checks a file again once it has indexed it after an edit, so new problems mean new answers.
  monaco.editor.onDidChangeMarkers((uris) => {
    const model = editor.getModel();
    if (model && uris.some((u) => u.toString() === model.uri.toString())) soon(300);
  });
  // A file without problems before or after an edit changes no markers.
  editor.onDidChangeModelContent(() => soon(2000));
  editor.onMouseDown((e) => {
    if (!e.event.leftButton || !e.target.element?.classList.contains("super-method")) return;
    const line = e.target.position?.lineNumber;
    const m = gutters.get(editor)!.members.find((m) => m.selection.start.line + 1 === line);
    if (!m) return;
    e.event.preventDefault();
    const at = { lineNumber: m.selection.start.line + 1, column: m.selection.start.character + 1 };
    const implementations = () => (editor.setPosition(at), editor.focus(), editor.trigger("gutter", "editor.action.goToImplementation", null));
    const supers = m.kind === "method" && m.supers.length > 0;
    if (supers && m.overridden)
      return showMenu(e.event.posx, e.event.posy, [
        { label: "Go to Super Method", run: () => (editor.setPosition(at), open(editor, m)) },
        { label: m.abstract ? "Go to Implementations" : "Go to Overriding Methods", run: implementations },
      ]);
    if (supers) return editor.setPosition(at), open(editor, m);
    implementations();
  });
}

export function initSuperMethods(h: typeof host) {
  host = h;
}
