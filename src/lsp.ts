// Language Server Protocol client: talks to the Rust bridge (src-tauri/src/lsp.rs)
// and exposes the server's features to Monaco as providers.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";

type M = typeof monaco.languages;

/** What the LSP client needs from the rest of the app. */
export type Host = {
  /** Returns the model for a file, loading it from disk if needed. */
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  /** Records that the model's current text is on disk. */
  markSaved(path: string): void;
  /** Moves an open tab after a file is renamed on disk. */
  renamed(from: string, to: string): void;
  status(text: string): void;
};

let host: Host;
let nextId = 1;
const pending = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
const diagnostics = new Map<string, L.Diagnostic[]>();
let ready: Promise<L.InitializeResult>;
let disposables: monaco.IDisposable[] = [];

const send = (msg: object) => invoke("lsp_send", { msg: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
const notify = (method: string, params: unknown) => send({ method, params });

async function request<T>(method: string, params: unknown): Promise<T> {
  await ready;
  const id = nextId++;
  const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
  await send({ id, method, params });
  return result;
}

listen<string>("lsp", ({ payload }) => {
  const msg = JSON.parse(payload);
  if (msg.method === undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p?.reject(msg.error) : p?.resolve(msg.result);
  } else if (msg.id !== undefined) {
    serverRequest(msg.method, msg.params).then(
      (result) => send({ id: msg.id, result: result ?? null }),
      (e) => send({ id: msg.id, error: { code: -32603, message: String(e) } }),
    );
  } else if (msg.method === "textDocument/publishDiagnostics") {
    diagnostics.set(msg.params.uri, msg.params.diagnostics);
    const model = monaco.editor.getModel(monaco.Uri.parse(msg.params.uri));
    if (model) setMarkers(model);
  } else if (msg.method === "window/showMessage" || msg.method === "window/logMessage") {
    if (msg.method === "window/showMessage" || msg.params.type === 1) host.status(msg.params.message);
  } else if (msg.method === "$/progress") {
    const v = msg.params.value;
    host.status(v.kind === "end" ? "" : [v.title, v.message ?? (v.percentage != null && `${v.percentage}%`)].filter(Boolean).join(" "));
  }
});

async function serverRequest(method: string, params: any): Promise<unknown> {
  switch (method) {
    case "workspace/applyEdit":
      await applyWorkspaceEdit(params.edit);
      return { applied: true };
    case "workspace/configuration":
      return params.items.map(() => null);
    case "window/showMessageRequest":
      host.status(params.message);
      return null;
    default: // client/registerCapability, window/workDoneProgress/create, and others need no work.
      return null;
  }
}

// ---- Conversions between LSP (0-based) and Monaco (1-based) ----

const toPos = (p: monaco.IPosition): L.Position => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r: L.Range): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});
const fromRange = (r: monaco.IRange): L.Range => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const doc = (model: monaco.editor.ITextModel) => ({ textDocument: { uri: model.uri.toString() } });
const at = (model: monaco.editor.ITextModel, pos: monaco.IPosition) => ({ ...doc(model), position: toPos(pos) });
const pathOf = (uri: string) => monaco.Uri.parse(uri).fsPath;
const markdown = (c: L.MarkupContent | L.MarkedString | string): monaco.IMarkdownString =>
  typeof c === "string" ? { value: c } : "kind" in c ? { value: c.value } : { value: "```" + c.language + "\n" + c.value + "\n```" };

// LSP enums are 1-based and in the same order as Monaco's names.
const completionKinds = "Text Method Function Constructor Field Variable Class Interface Module Property Unit Value Enum Keyword Snippet Color File Reference Folder EnumMember Constant Struct Event Operator TypeParameter".split(" ");
const severity = [0, 8, 4, 2, 1]; // Error, Warning, Information, Hint

function setMarkers(model: monaco.editor.ITextModel) {
  const list = diagnostics.get(model.uri.toString()) ?? [];
  monaco.editor.setModelMarkers(
    model,
    "lsp",
    list.map((d) => ({ ...toRange(d.range), message: typeof d.message === "string" ? d.message : d.message.value, severity: severity[d.severity ?? 1], source: d.source, code: d.code?.toString() })),
  );
}

/** Converts locations and loads their files, because Monaco can only show locations in existing models. */
async function locations(result: L.Location | L.Location[] | L.LocationLink[] | null): Promise<monaco.languages.Location[]> {
  const list = !result ? [] : Array.isArray(result) ? result : [result];
  const locs = list.map((l) => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l));
  await Promise.all(locs.map((l) => host.ensureModel(pathOf(l.uri))));
  return locs.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
}

// ---- Workspace edits ----

/** Applies an edit and saves every touched file, as PhpStorm does for refactorings. */
export async function applyWorkspaceEdit(edit: L.WorkspaceEdit) {
  const ops: (L.TextDocumentEdit | L.CreateFile | L.RenameFile | L.DeleteFile)[] =
    edit.documentChanges ?? Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits }));
  for (const op of ops) {
    if (!("kind" in op)) {
      const path = pathOf(op.textDocument.uri);
      const model = await host.ensureModel(path);
      model.pushEditOperations([], op.edits.map((e) => ({ range: toRange(e.range), text: "newText" in e ? e.newText : "" })), () => null);
      await invoke("write_file", { path, contents: model.getValue() });
      host.markSaved(path);
    } else if (op.kind === "create") {
      await invoke("write_file", { path: pathOf(op.uri), contents: "" });
    } else if (op.kind === "rename") {
      const [from, to] = [pathOf(op.oldUri), pathOf(op.newUri)];
      await invoke("rename_path", { from, to });
      host.renamed(from, to);
    } else if (op.kind === "delete") {
      await invoke("remove_path", { path: pathOf(op.uri) });
    }
  }
}

const execute = (c: L.Command) => request("workspace/executeCommand", { command: c.command, arguments: c.arguments });

monaco.editor.registerCommand("lsp.codeAction", async (_, item: L.CodeAction | L.Command) => {
  if (typeof item.command === "string") return execute(item as L.Command);
  let action = item as L.CodeAction;
  const cap = serverCaps.codeActionProvider;
  if (!action.edit && !action.command && typeof cap === "object" && cap.resolveProvider) {
    action = await request<L.CodeAction>("codeAction/resolve", action);
  }
  if (action.edit) await applyWorkspaceEdit(action.edit);
  if (action.command) await execute(action.command);
});

// ---- Document sync ----

const isPhp = (model: monaco.editor.ITextModel) => model.getLanguageId() === "php";

function track(model: monaco.editor.ITextModel) {
  if (!isPhp(model) || model.uri.scheme !== "file") return;
  const uri = model.uri.toString();
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "php", version: model.getVersionId(), text: model.getValue() } });
  // ponytail: full-text sync on every change; switch to incremental if large files lag.
  const sub = model.onDidChangeContent(() =>
    notify("textDocument/didChange", { textDocument: { uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] }),
  );
  model.onWillDispose(() => {
    sub.dispose();
    notify("textDocument/didClose", { textDocument: { uri } });
  });
  setMarkers(model);
}

export function didSave(model: monaco.editor.ITextModel) {
  if (isPhp(model)) notify("textDocument/didSave", doc(model));
}

// ---- Startup ----

let serverCaps: L.ServerCapabilities = {};

export async function startLsp(root: string, h: Host) {
  host = h;
  disposables.forEach((d) => d.dispose());
  disposables = [];
  pending.clear();
  diagnostics.clear();
  await invoke("lsp_start", { root });
  const id = nextId++;
  ready = new Promise<L.InitializeResult>((resolve, reject) => pending.set(id, { resolve, reject }));
  await send({
    id,
    method: "initialize",
    params: {
      processId: null,
      rootUri: monaco.Uri.file(root).toString(),
      workspaceFolders: [{ uri: monaco.Uri.file(root).toString(), name: root.split("/").pop()! }],
      initializationOptions: {
        "language_server_worse_reflection.inlay_hints.enable": true,
        "language_server_worse_reflection.inlay_hints.types": true,
        "language_server_worse_reflection.inlay_hints.params": true,
      },
      capabilities: {
        workspace: {
          applyEdit: true,
          configuration: true,
          workspaceFolders: true,
          workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
        },
        textDocument: {
          synchronization: { didSave: true },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
          definition: {},
          declaration: {},
          typeDefinition: {},
          implementation: {},
          references: {},
          documentHighlight: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] } },
            resolveSupport: { properties: ["edit"] },
          },
          formatting: {},
          rename: { prepareSupport: true },
          publishDiagnostics: {},
          foldingRange: {},
          selectionRange: {},
          inlayHint: {},
        },
        window: { workDoneProgress: true },
      },
    } satisfies L.InitializeParams,
  });
  serverCaps = (await ready).capabilities;
  await notify("initialized", {});
  monaco.editor.getModels().forEach(track);
  disposables.push(monaco.editor.onDidCreateModel(track));
  registerProviders(monaco.languages);
}

function registerProviders(ml: M) {
  const c = serverCaps;
  const reg = (d: monaco.IDisposable) => disposables.push(d);

  if (c.completionProvider) {
    reg(ml.registerCompletionItemProvider("php", {
      triggerCharacters: c.completionProvider.triggerCharacters,
      async provideCompletionItems(model, pos) {
        const res = await request<L.CompletionList | L.CompletionItem[] | null>("textDocument/completion", at(model, pos));
        const items = Array.isArray(res) ? res : res?.items ?? [];
        const word = model.getWordUntilPosition(pos);
        const fallback = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        return {
          incomplete: !Array.isArray(res) && !!res?.isIncomplete,
          suggestions: items.map((i) => {
            const edit = i.textEdit && ("range" in i.textEdit ? i.textEdit.range : i.textEdit.replace);
            return {
              label: i.label,
              kind: ml.CompletionItemKind[completionKinds[(i.kind ?? 1) - 1] as keyof typeof ml.CompletionItemKind],
              detail: i.detail,
              documentation: i.documentation && markdown(i.documentation),
              insertText: i.textEdit?.newText ?? i.insertText ?? i.label,
              insertTextRules: i.insertTextFormat === 2 ? ml.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: edit ? toRange(edit) : fallback,
              sortText: i.sortText,
              filterText: i.filterText,
              additionalTextEdits: i.additionalTextEdits?.map((e) => ({ range: toRange(e.range), text: e.newText })),
            };
          }),
        };
      },
    }));
  }

  if (c.hoverProvider) {
    reg(ml.registerHoverProvider("php", {
      async provideHover(model, pos) {
        const h = await request<L.Hover | null>("textDocument/hover", at(model, pos));
        if (!h) return null;
        const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
        return { contents: contents.map(markdown), range: h.range && toRange(h.range) };
      },
    }));
  }

  if (c.signatureHelpProvider) {
    reg(ml.registerSignatureHelpProvider("php", {
      signatureHelpTriggerCharacters: c.signatureHelpProvider.triggerCharacters,
      signatureHelpRetriggerCharacters: c.signatureHelpProvider.retriggerCharacters,
      async provideSignatureHelp(model, pos) {
        const s = await request<L.SignatureHelp | null>("textDocument/signatureHelp", at(model, pos));
        if (!s) return null;
        return {
          value: {
            activeSignature: s.activeSignature ?? 0,
            activeParameter: s.activeParameter ?? 0,
            signatures: s.signatures.map((sig) => ({
              label: sig.label,
              documentation: sig.documentation && markdown(sig.documentation),
              parameters: (sig.parameters ?? []).map((p) => ({ label: p.label, documentation: p.documentation && markdown(p.documentation) })),
            })),
          },
          dispose() {},
        };
      },
    }));
  }

  const nav = [
    ["definitionProvider", "registerDefinitionProvider", "provideDefinition", "textDocument/definition"],
    ["declarationProvider", "registerDeclarationProvider", "provideDeclaration", "textDocument/declaration"],
    ["typeDefinitionProvider", "registerTypeDefinitionProvider", "provideTypeDefinition", "textDocument/typeDefinition"],
    ["implementationProvider", "registerImplementationProvider", "provideImplementation", "textDocument/implementation"],
  ] as const;
  for (const [cap, register, method, lspMethod] of nav) {
    if (!c[cap]) continue;
    reg((ml[register] as any)("php", { [method]: async (model: any, pos: any) => locations(await request(lspMethod, at(model, pos))) }));
  }

  if (c.referencesProvider) {
    reg(ml.registerReferenceProvider("php", {
      async provideReferences(model, pos, context) {
        return locations(await request("textDocument/references", { ...at(model, pos), context }));
      },
    }));
  }

  if (c.documentHighlightProvider) {
    reg(ml.registerDocumentHighlightProvider("php", {
      async provideDocumentHighlights(model, pos) {
        const hs = await request<L.DocumentHighlight[] | null>("textDocument/documentHighlight", at(model, pos));
        return (hs ?? []).map((h) => ({ range: toRange(h.range), kind: (h.kind ?? 1) - 1 }));
      },
    }));
  }

  if (c.documentSymbolProvider) {
    reg(ml.registerDocumentSymbolProvider("php", {
      async provideDocumentSymbols(model) {
        const syms = await request<(L.DocumentSymbol | L.SymbolInformation)[] | null>("textDocument/documentSymbol", doc(model));
        const convert = (s: L.DocumentSymbol | L.SymbolInformation): monaco.languages.DocumentSymbol => {
          const range = toRange("location" in s ? s.location.range : s.range);
          return {
            name: s.name,
            detail: ("detail" in s && s.detail) || "",
            kind: s.kind - 1,
            tags: [],
            range,
            selectionRange: "selectionRange" in s ? toRange(s.selectionRange) : range,
            children: "children" in s ? s.children?.map(convert) : undefined,
          };
        };
        return (syms ?? []).map(convert);
      },
    }));
  }

  if (c.codeActionProvider) {
    reg(ml.registerCodeActionProvider("php", {
      async provideCodeActions(model, range, context) {
        const diags = diagnostics.get(model.uri.toString()) ?? [];
        const overlapping = diags.filter((d) => monaco.Range.areIntersectingOrTouching(toRange(d.range), range));
        const res = await request<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
          ...doc(model),
          range: fromRange(range),
          context: { diagnostics: overlapping, only: context.only ? [context.only] : undefined },
        });
        return {
          actions: (res ?? []).map((a) => ({
            title: a.title,
            kind: "kind" in a ? a.kind : undefined,
            isPreferred: "isPreferred" in a ? a.isPreferred : undefined,
            command: { id: "lsp.codeAction", title: a.title, arguments: [a] },
          })),
          dispose() {},
        };
      },
    }));
  }

  if (c.documentFormattingProvider) {
    reg(ml.registerDocumentFormattingEditProvider("php", {
      async provideDocumentFormattingEdits(model, options) {
        const edits = await request<L.TextEdit[] | null>("textDocument/formatting", { ...doc(model), options });
        return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
      },
    }));
  }

  if (c.renameProvider) {
    const prepare = typeof c.renameProvider === "object" && c.renameProvider.prepareProvider;
    reg(ml.registerRenameProvider("php", {
      // Monaco can't create or rename files, so apply the edit here and hand Monaco nothing.
      async provideRenameEdits(model, pos, newName) {
        const edit = await request<L.WorkspaceEdit | null>("textDocument/rename", { ...at(model, pos), newName });
        if (edit) await applyWorkspaceEdit(edit);
        return { edits: [] };
      },
      resolveRenameLocation: prepare
        ? async (model, pos) => {
            const r = await request<L.PrepareRenameResult | null>("textDocument/prepareRename", at(model, pos));
            if (!r) return { range: new monaco.Range(1, 1, 1, 1), text: "", rejectReason: "This element can't be renamed." };
            if ("defaultBehavior" in r) {
              const w = model.getWordAtPosition(pos)!;
              return { range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn), text: w.word };
            }
            const range = toRange("range" in r ? r.range : r);
            return { range, text: "placeholder" in r ? r.placeholder : model.getValueInRange(range) };
          }
        : undefined,
    }));
  }

  if (c.foldingRangeProvider) {
    reg(ml.registerFoldingRangeProvider("php", {
      async provideFoldingRanges(model) {
        const fs = await request<L.FoldingRange[] | null>("textDocument/foldingRange", doc(model));
        return (fs ?? []).map((f) => ({ start: f.startLine + 1, end: f.endLine + 1, kind: f.kind ? new ml.FoldingRangeKind(f.kind) : undefined }));
      },
    }));
  }

  if (c.selectionRangeProvider) {
    reg(ml.registerSelectionRangeProvider("php", {
      async provideSelectionRanges(model, positions) {
        const res = await request<L.SelectionRange[] | null>("textDocument/selectionRange", { ...doc(model), positions: positions.map(toPos) });
        return (res ?? []).map((s) => {
          const chain: monaco.languages.SelectionRange[] = [];
          for (let r: L.SelectionRange | undefined = s; r; r = r.parent) chain.push({ range: toRange(r.range) });
          return chain;
        });
      },
    }));
  }

  if (c.inlayHintProvider) {
    reg(ml.registerInlayHintsProvider("php", {
      async provideInlayHints(model, range) {
        const hints = await request<L.InlayHint[] | null>("textDocument/inlayHint", { ...doc(model), range: fromRange(range) });
        return {
          hints: (hints ?? []).map((h) => ({
            label: typeof h.label === "string" ? h.label : h.label.map((p) => p.value).join(""),
            position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
            kind: h.kind,
            paddingLeft: h.paddingLeft,
            paddingRight: h.paddingRight,
          })),
          dispose() {},
        };
      },
    }));
  }
}
