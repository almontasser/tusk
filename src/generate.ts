// Generate (⌘N in a PHP file), as in PhpStorm: a constructor, getters, setters, __toString(), and methods to
// implement or override. Phpactor writes getters, setters, and methods through its commands and code actions;
// the constructor from properties and __toString() are written here, since Phpactor has no such action.
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { applyWorkspaceEdit, phpactorRequest, typeSymbol } from "./lsp";
import { pick, type Item } from "./palette";
import { abstractMethods, parseTypeDeclarations, shortenNames, type TypeDeclaration } from "./phptypes";
import { readText } from "./projectfiles";
import { snippetText } from "./postfix";
import { classProperties, matchBracket, type Property } from "./refactorparse";

type Host = { status(text: string): void };
let host: Host;

// Phpactor's code actions that generate code, by kind.
const PHPACTOR_KINDS = /^quickfix\.(complete_constructor|promote_constructor|implement_contracts|override_method|add_missing_properties)/;

const upperFirst = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Runs a Phpactor code action or command: its edit, then its command, whose edits come back as `workspace/applyEdit`. */
async function runAction(a: L.CodeAction | L.Command) {
  const command = typeof a.command === "string" ? (a as L.Command) : a.command;
  if ("edit" in a && a.edit) await applyWorkspaceEdit(a.edit);
  if (command) await phpactorRequest("workspace/executeCommand", { command: command.command, arguments: command.arguments });
}

/** Inserts a snippet at the start of a 1-based line. */
function insertAt(editor: monaco.editor.ICodeEditor, line: number, snippet: string) {
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.focus();
  (editor.getContribution("snippetController2") as unknown as { insert(template: string): void }).insert(snippet);
}

export async function generate(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Generate works in PHP files.");
  const text = model.getValue();
  const offset = model.getOffsetAt(pos);
  const types = parseTypeDeclarations(text);
  const type = types.filter((t) => t.offset <= offset).at(-1) ?? types[0];
  const open = type ? text.indexOf("{", type.offset) : -1;
  const close = open >= 0 ? matchBracket(text, open) : -1;
  if (!type || close < 0 || type.kind === "interface") return host.status("Put the cursor in a class, trait, or enum to generate code.");
  const body = text.slice(open + 1, close);
  const all = classProperties(body);
  const props = all.filter((p) => !p.isStatic);
  const has = (method: string) => new RegExp(`\\bfunction\\s+&?${method}\\s*\\(`, "i").test(body);
  const { insertSpaces, indentSize } = model.getOptions();
  const unit = insertSpaces ? " ".repeat(indentSize) : "\t";
  const closeLine = model.getPositionAt(close).lineNumber;
  const indent = model.getLineContent(closeLine).match(/^\s*/)![0] + unit;
  // A new method goes last, after a blank line unless the line before the brace is blank already. The brace is
  // found again, since Phpactor's Implement Methods may have added lines first.
  const atEnd = (code: string) => {
    const now = model.getValue();
    const decl = parseTypeDeclarations(now).find((t) => t.fqn === type.fqn);
    const brace = decl ? matchBracket(now, now.indexOf("{", decl.offset)) : -1;
    const line = brace >= 0 ? model.getPositionAt(brace).lineNumber : closeLine;
    insertAt(editor, line, (model.getLineContent(line - 1).trim() ? "\n" : "") + code);
  };
  const method = (signature: string, lines: string[]) => [`${indent}${signature}`, `${indent}{`, ...lines.map((l) => `${indent}${unit}${l}`), `${indent}}`, ""].join("\n");

  const items: Item[] = [];
  const unset = props.filter((p) => !p.promoted && !p.hasDefault);
  if (unset.length && !has("__construct"))
    items.push({ label: "Constructor", detail: unset.map((p) => `$${p.name}`).join(", "), run: () => constructor(editor, model, open + 1 + Math.max(...all.map((p) => p.end)), unset, method) });
  // Getters and setters from Phpactor, named getTitle and setTitle as in PhpStorm (see the settings in src/lsp.ts).
  // The class's offset in UTF-8 bytes tells Phpactor which class of the file is meant.
  const at = new TextEncoder().encode(text.slice(0, type.offset)).length;
  const run = (command: string, names: string[]) => phpactorRequest("workspace/executeCommand", { command, arguments: [model.uri.toString(), at, names] });
  const getters = props.filter((p) => !has(`get${upperFirst(p.name)}`)).map((p) => p.name);
  const setters = props.filter((p) => !p.readonly && !has(`set${upperFirst(p.name)}`)).map((p) => p.name);
  if (getters.length) items.push({ label: "Getters", detail: getters.map((n) => `$${n}`).join(", "), run: () => run("generate_accessors", getters) });
  if (setters.length) items.push({ label: "Setters", detail: setters.map((n) => `$${n}`).join(", "), run: () => run("generate_mutators", setters) });
  if (getters.length && setters.length)
    items.push({ label: "Getters and Setters", run: async () => (await run("generate_accessors", getters), await run("generate_mutators", setters)) });
  if (!has("__toString")) items.push({ label: "__toString()", run: () => atEnd(method("public function __toString(): string", ["return ${1:''};$0"])) });

  const actions =
    (await phpactorRequest<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
      textDocument: { uri: model.uri.toString() },
      range: { start: { line: pos.lineNumber - 1, character: pos.column - 1 }, end: { line: pos.lineNumber - 1, character: pos.column - 1 } },
      context: { diagnostics: [] },
    }).catch(() => null)) ?? [];
  // Phpactor implements interfaces and abstract parents, but skips the abstract methods of the class's traits.
  const stubs = (await traitAbstracts(type)).filter((m) => !has(m.name));
  const writeStubs = () => atEnd(snippetText(stubs.map((m) => method(shortenNames(m.signature, text), [])).join("\n")));
  let implemented = false;
  for (const a of actions) {
    const kind = "kind" in a ? a.kind : undefined;
    if (!kind || !PHPACTOR_KINDS.test(kind)) continue;
    const implement = kind.includes("implement_contracts");
    implemented ||= implement;
    const label = implement ? "Implement Methods…" : kind.includes("override_method") ? "Override Methods…" : a.title;
    items.push({ label, detail: kind.includes("override") ? a.title : undefined, run: () => (implement && stubs.length ? runAction(a).then(writeStubs) : runAction(a)) });
  }
  if (!implemented && stubs.length) items.push({ label: "Implement Methods…", detail: stubs.map((m) => `${m.name}()`).join(", "), run: writeStubs });
  if (!items.length) return host.status("Nothing to generate here.");
  pick("Generate", () => items);
}

/**
 * The abstract methods of the traits a type uses, and of the traits those use, each read from its file.
 * ponytail: a trait that Phpactor's index doesn't know yet, such as one created since the last index, is skipped.
 */
async function traitAbstracts(type: TypeDeclaration): Promise<{ name: string; signature: string }[]> {
  const queue = [...type.uses];
  const seen = new Set(queue);
  const methods: { name: string; signature: string }[] = [];
  for (let fqn = queue.shift(); fqn; fqn = queue.shift()) {
    const path = (await typeSymbol(fqn))?.path;
    if (!path) continue;
    const source = monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? (await readText(path).catch(() => ""));
    const types = parseTypeDeclarations(source);
    const i = types.findIndex((t) => t.fqn === fqn);
    if (i < 0) continue;
    for (const m of abstractMethods(source, types[i].offset, types[i + 1]?.offset)) if (!methods.some((x) => x.name === m.name)) methods.push(m);
    for (const u of types[i].uses) if (!seen.has(u)) (seen.add(u), queue.push(u));
  }
  return methods;
}

/** Inserts a constructor that takes and assigns the properties, below the line of `after`: the last property's `;`. */
function constructor(editor: monaco.editor.ICodeEditor, model: monaco.editor.ITextModel, after: number, props: Property[], method: (signature: string, lines: string[]) => string) {
  const params = props.map((p) => `${p.type ? `${p.type} ` : ""}$${p.name}`).join(", ");
  // The cursor ends after the last assignment, marked with a character snippets don't escape.
  const assignments = props.map((p, i) => `$this->${p.name} = $${p.name};${i === props.length - 1 ? "\0" : ""}`);
  const code = method(`public function __construct(${params})`, assignments);
  const line = model.getPositionAt(after).lineNumber;
  insertAt(editor, line + 1, `\n${snippetText(code).replace("\0", "$0")}`);
}

export function initGenerate(h: Host) {
  host = h;
}
