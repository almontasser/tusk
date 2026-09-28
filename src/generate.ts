// Generate (⌘N in a PHP file), as in PhpStorm: a constructor, getters, setters, __toString(), and methods to
// implement or override. Tusk's server offers them as code actions for the class at the cursor: `source.generate.*`
// for all but the fixes (Implement Methods and the constructor and property fixes), which are quick fixes.
import { showError } from "./status";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { runTuskAction, tuskRequest } from "./lsp";
import { pick, type Item } from "./palette";

type Host = { status(text: string): void };
let host: Host;

// The server's code actions that generate code, by kind, with the menu's label: its title shows as the detail.
const LABELS: [RegExp, string][] = [
  [/^source\.generate\.constructor/, "Constructor"],
  [/^source\.generate\.getters/, "Getters"],
  [/^source\.generate\.setters/, "Setters"],
  [/^source\.generate\.accessors/, "Getters and Setters"],
  [/^source\.generate\.toString/, "__toString()"],
  [/^quickfix\.implement_contracts/, "Implement Methods…"],
  [/^source\.generate\.override/, "Override Methods…"],
  [/^quickfix\.(complete_constructor|promote_constructor|add_missing_properties)/, ""],
];

export async function generate(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Generate works in PHP files.");
  const at = { line: pos.lineNumber - 1, character: pos.column - 1 };
  const found = await tuskRequest<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
    textDocument: { uri: model.uri.toString() },
    range: { start: at, end: at },
    context: { diagnostics: [], only: ["source.generate", "quickfix"] },
  }).catch((e) => (showError("Can't list what to generate", e), undefined));
  if (found === undefined) return;
  const actions = found ?? [];
  const items: (Item & { order: number })[] = [];
  for (const a of actions) {
    const kind = "kind" in a ? (a.kind ?? "") : "";
    const order = LABELS.findIndex(([re]) => re.test(kind));
    if (order < 0) continue;
    const label = LABELS[order][1];
    // Detail: the properties a constructor or accessor takes, or the method an override is for.
    const detail = label && !/^(Implement|Getters and|__toString)/.test(label) ? a.title.replace(/^\w+ for /, "") : undefined;
    items.push({ label: label || a.title, detail, order, run: () => runTuskAction(a) });
  }
  // In the menu's order, as PhpStorm lists them.
  items.sort((a, b) => a.order - b.order);
  if (!items.length) return host.status("Nothing to generate here.");
  pick("Generate", () => items);
}

export function initGenerate(h: Host) {
  host = h;
}
