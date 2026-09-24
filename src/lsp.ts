// Language Server Protocol client: talks to the Rust bridge (src-tauri/src/lsp.rs)
// and exposes each server's features to Monaco as providers. Several servers can
// serve the same language; Monaco merges their completions, locations, hovers,
// code actions, and markers.
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
const servers: Server[] = [];

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

function setMarkers(model: monaco.editor.ITextModel, owner: string, list: L.Diagnostic[]) {
  monaco.editor.setModelMarkers(
    model,
    owner,
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

// Code actions carry the function that runs them, so each one goes back to the server that made it.
monaco.editor.registerCommand("lsp.codeAction", (_, run: (a: L.CodeAction | L.Command) => Promise<void>, action) => run(action));

const clientCapabilities: L.ClientCapabilities = {
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
    documentLink: {},
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
};

type Server = { stop(): void; didSave(model: monaco.editor.ITextModel): void };

/** Starts the bundled server `name` for the given Monaco languages. */
async function startServer(name: string, root: string, langs: string[], initializationOptions: object): Promise<Server> {
  let nextId = 1;
  const pending = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
  const diagnostics = new Map<string, L.Diagnostic[]>();
  const disposables: monaco.IDisposable[] = [];
  const reg = (d: monaco.IDisposable) => disposables.push(d);
  const owner = `lsp:${name}`;
  let ready: Promise<unknown> = Promise.resolve();

  const send = (msg: object) => invoke("lsp_send", { name, msg: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
  const notify = (method: string, params: unknown) => send({ method, params });
  const call = <T>(method: string, params: unknown) => {
    const id = nextId++;
    const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
    return send({ id, method, params }).then(() => result);
  };
  const request = async <T>(method: string, params: unknown): Promise<T> => (await ready, call<T>(method, params));

  const unlisten = await listen<string>(owner, ({ payload }) => {
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
      if (model) setMarkers(model, owner, msg.params.diagnostics);
    } else if (msg.method === "window/showMessage" || (msg.method === "window/logMessage" && msg.params.type === 1)) {
      host.status(`${name}: ${msg.params.message}`);
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
        host.status(`${name}: ${params.message}`);
        return null;
      default: // client/registerCapability, window/workDoneProgress/create, and others need no work.
        return null;
    }
  }

  const execute = (cmd: L.Command) => request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments });

  async function runCodeAction(item: L.CodeAction | L.Command) {
    if (typeof item.command === "string") return void (await execute(item as L.Command));
    let action = item as L.CodeAction;
    const cap = c.codeActionProvider;
    if (!action.edit && !action.command && typeof cap === "object" && cap.resolveProvider) {
      action = await request<L.CodeAction>("codeAction/resolve", action);
    }
    if (action.edit) await applyWorkspaceEdit(action.edit);
    if (action.command) await execute(action.command);
  }

  const serves = (model: monaco.editor.ITextModel) => langs.includes(model.getLanguageId()) && model.uri.scheme === "file";

  function track(model: monaco.editor.ITextModel) {
    if (!serves(model)) return;
    const uri = model.uri.toString();
    notify("textDocument/didOpen", { textDocument: { uri, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() } });
    // ponytail: full-text sync on every change; switch to incremental if large files lag.
    reg(model.onDidChangeContent(() =>
      notify("textDocument/didChange", { textDocument: { uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] }),
    ));
    reg(model.onWillDispose(() => notify("textDocument/didClose", { textDocument: { uri } })));
    setMarkers(model, owner, diagnostics.get(uri) ?? []);
  }

  const processId = await invoke<number>("lsp_start", { name, root });
  const init = call<L.InitializeResult>("initialize", {
    processId,
    rootUri: monaco.Uri.file(root).toString(),
    workspaceFolders: [{ uri: monaco.Uri.file(root).toString(), name: root.split("/").pop()! }],
    initializationOptions,
    capabilities: clientCapabilities,
  } satisfies L.InitializeParams);
  ready = init;
  const c = (await init).capabilities;
  await notify("initialized", {});
  monaco.editor.getModels().forEach(track);
  reg(monaco.editor.onDidCreateModel(track));
  registerProviders(monaco.languages);

  return {
    stop() {
      unlisten();
      disposables.forEach((d) => d.dispose());
      monaco.editor.getModels().forEach((m) => monaco.editor.setModelMarkers(m, owner, []));
    },
    didSave(model) {
      if (serves(model)) notify("textDocument/didSave", { textDocument: { uri: model.uri.toString() } });
    },
  };

  function registerProviders(ml: M) {

    if (c.completionProvider) {
      reg(ml.registerCompletionItemProvider(langs, {
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
      reg(ml.registerHoverProvider(langs, {
        async provideHover(model, pos) {
          const h = await request<L.Hover | null>("textDocument/hover", at(model, pos));
          if (!h) return null;
          const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
          return { contents: contents.map(markdown), range: h.range && toRange(h.range) };
        },
      }));
    }

    if (c.signatureHelpProvider) {
      reg(ml.registerSignatureHelpProvider(langs, {
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
      reg((ml[register] as any)(langs, { [method]: async (model: any, pos: any) => locations(await request(lspMethod, at(model, pos))) }));
    }

    if (c.referencesProvider) {
      reg(ml.registerReferenceProvider(langs, {
        async provideReferences(model, pos, context) {
          return locations(await request("textDocument/references", { ...at(model, pos), context }));
        },
      }));
    }

    if (c.documentHighlightProvider) {
      reg(ml.registerDocumentHighlightProvider(langs, {
        async provideDocumentHighlights(model, pos) {
          const hs = await request<L.DocumentHighlight[] | null>("textDocument/documentHighlight", at(model, pos));
          return (hs ?? []).map((h) => ({ range: toRange(h.range), kind: (h.kind ?? 1) - 1 }));
        },
      }));
    }

    if (c.documentSymbolProvider) {
      reg(ml.registerDocumentSymbolProvider(langs, {
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
      reg(ml.registerCodeActionProvider(langs, {
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
              command: { id: "lsp.codeAction", title: a.title, arguments: [runCodeAction, a] },
            })),
            dispose() {},
          };
        },
      }));
    }

    if (c.documentFormattingProvider) {
      reg(ml.registerDocumentFormattingEditProvider(langs, {
        async provideDocumentFormattingEdits(model, options) {
          const edits = await request<L.TextEdit[] | null>("textDocument/formatting", { ...doc(model), options });
          return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
        },
      }));
    }

    if (c.renameProvider) {
      const prepare = typeof c.renameProvider === "object" && c.renameProvider.prepareProvider;
      reg(ml.registerRenameProvider(langs, {
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
      reg(ml.registerFoldingRangeProvider(langs, {
        async provideFoldingRanges(model) {
          const fs = await request<L.FoldingRange[] | null>("textDocument/foldingRange", doc(model));
          return (fs ?? []).map((f) => ({ start: f.startLine + 1, end: f.endLine + 1, kind: f.kind ? new ml.FoldingRangeKind(f.kind) : undefined }));
        },
      }));
    }

    if (c.selectionRangeProvider) {
      reg(ml.registerSelectionRangeProvider(langs, {
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
      reg(ml.registerInlayHintsProvider(langs, {
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

    if (c.documentLinkProvider) {
      reg(ml.registerLinkProvider(langs, {
        async provideLinks(model) {
          const links = await request<L.DocumentLink[] | null>("textDocument/documentLink", doc(model));
          return { links: (links ?? []).map((l) => ({ range: toRange(l.range), url: l.target, tooltip: l.tooltip })) };
        },
      }));
    }
  }
}

/** Starts the language servers for a project, stopping those of the previous project. */
export async function startLsp(root: string, h: Host) {
  host = h;
  servers.splice(0).forEach((s) => s.stop());
  const exists = (path: string) => invoke<boolean>("path_exists", { path: `${root}/${path}` });
  const tool = (name: string) => invoke<string>("tool_path", { name });
  const phpactor = startServer("phpactor", root, ["php"], {
    "language_server_worse_reflection.inlay_hints.enable": true,
    "language_server_worse_reflection.inlay_hints.types": true,
    "language_server_worse_reflection.inlay_hints.params": true,
    "language_server_mago.enabled": true,
    "language_server_mago.bin": await tool("mago"),
    // Without a project mago.toml, use defaults tuned for Laravel (src-tauri/resources/mago.toml).
    ...(!(await exists("mago.toml")) && { "language_server_mago.config": await tool("mago.toml") }),
    "language_server_phpstan.enabled": await exists("vendor/bin/phpstan"),
  });
  const laravel = (await exists("artisan"))
    ? startServer("laravel", root, ["php", "blade"], {})
    : null;
  for (const s of await Promise.allSettled([phpactor, laravel])) {
    if (s.status === "fulfilled" && s.value) servers.push(s.value);
    else if (s.status === "rejected") host.status(`Language server failed: ${s.reason}`);
  }
}

export const didSave = (model: monaco.editor.ITextModel) => servers.forEach((s) => s.didSave(model));
