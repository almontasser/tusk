// Language Server Protocol client: talks to the Rust bridge (src-tauri/src/lsp.rs)
// and exposes each server's features to Monaco as providers. Several servers can
// serve the same language; Monaco merges their completions, locations, hovers,
// code actions, and markers.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { choose } from "./palette";
import { formatHoverMarkdown } from "./phptypes";
import { settings } from "./settings";
import { writeText } from "./projectfiles";
import { aliasStubs, facts, introspect, onModelsRead, projectCache, readModels, rereadModels } from "./eloquent";
import { isDeprecation, isLibrary, isUnused, magoConfigText, magoExpect, magoIssuesByFile, problemMarkdown, realProblems, ruleLabel, severityOf } from "./diagnostics";
import { bladeProblems, bladeToPhp } from "./bladephp";
import { covers, DEFAULT_EXCLUDES, magoExcludes } from "./indexexclude";
import { onProjectValue, projectScope, projectValue, setProjectValue } from "./projectstate";
import { editExclusions, type Folder } from "./indexexcludedialog";
import { toast } from "./dom";

type M = typeof monaco.languages;

/** What the LSP client needs from the rest of the app. */
export type Host = {
  /** Returns the model for a file, loading it from disk if needed. */
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  /** Records that the model's current text is on disk. */
  markSaved(path: string): void;
  /** Moves an open tab after a file is renamed on disk. */
  renamed(from: string, to: string): void;
  /** Closes a deleted file's tab and drops its model. */
  forget(path: string): void;
  /** Opens a file at a 1-based line. */
  openAt(path: string, line: number): void;
  /** Shows a status message; each source has its own slot, and "" clears it. */
  status(text: string, source?: string): void;
};

let host: Host;
const servers: Server[] = [];

/**
 * Shows a server's question in the picker and returns the chosen action, or null if dismissed.
 */
async function askUser(server: string, params: L.ShowMessageRequestParams): Promise<L.MessageActionItem | null> {
  const actions = params.actions ?? [];
  const result = await choose(`${server}: ${params.message}`, actions.length ? actions.map((x) => x.title) : ["OK"]);
  return actions.find((x) => x.title === result) ?? null;
}

// ---- Conversions between LSP (0-based) and Monaco (1-based) ----

/** A model's text, read once per version and shared by every server that needs it. */
const texts = new WeakMap<monaco.editor.ITextModel, { version: number; text: string }>();
function textOf(model: monaco.editor.ITextModel) {
  const version = model.getVersionId();
  let cached = texts.get(model);
  if (cached?.version !== version) texts.set(model, (cached = { version, text: model.getValue() }));
  return cached.text;
}

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

/**
 * The last diagnostics each server sent for each model, so they can be filtered again once the models are read, and
 * the ones left after filtering (`shown`), which code action requests send.
 */
const lastDiagnostics = new Map<string, { model: monaco.editor.ITextModel; owner: string; list: L.Diagnostic[]; shown: L.Diagnostic[] }>();
onModelsRead(() => lastDiagnostics.forEach(({ model, owner, list }) => !model.isDisposed() && setMarkers(model, owner, list)));

/**
 * Files Tusk's server has checked since they opened, whose markers from it are current. The Problems panel
 * (problems.ts) shows its scan for the others.
 */
export const diagnosed = new Set<string>();
function markDiagnosed(model: monaco.editor.ITextModel) {
  if (diagnosed.has(model.uri.fsPath)) return;
  model.onWillDispose(() => diagnosed.delete(model.uri.fsPath));
  diagnosed.add(model.uri.fsPath);
}

function setMarkers(model: monaco.editor.ITextModel, owner: string, list: L.Diagnostic[]) {
  const key = `${owner} ${model.uri}`;
  if (!lastDiagnostics.has(key)) model.onWillDispose(() => lastDiagnostics.delete(key));
  const shown = realProblems(model.uri.path, textOf(model), model.getLanguageId(), list, facts);
  lastDiagnostics.set(key, { model, owner, list, shown });
  monaco.editor.setModelMarkers(model, owner, shown.map((d) => toMarker(d, owner)));
}

const toMarker = (d: L.Diagnostic, owner: string): monaco.editor.IMarkerData => ({
  ...toRange(d.range),
  message: typeof d.message === "string" ? d.message : d.message.value,
  ...(owner === "lsp:typos" && spelling.severity !== "typo"
    ? { severity: spelling.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning }
    : owner === "lsp:typos"
    ? // Monaco draws a hint with the deprecated tag without a squiggle; the typo decorations below draw spelling's own.
      { severity: monaco.MarkerSeverity.Hint, tags: [monaco.MarkerTag.Deprecated] }
    : {
        severity: severity[severityOf(d)],
        // LSP's diagnostic tags have MarkerTag's numbers.
        tags: [...new Set([...(d.tags ?? []), ...(isDeprecation(d) ? [monaco.MarkerTag.Deprecated] : isUnused(d) ? [monaco.MarkerTag.Unnecessary] : [])])],
      }),
  source: d.source ?? owner.slice(4),
  code: d.code?.toString(),
});

/**
 * Spelling gets a green wavy underline of its own, as in PhpStorm, since Monaco styles markers by severity only.
 * Following the markers, rather than the server's publishes, clears the underlines when the spell checker stops.
 */
const typoDecorations = new Map<string, string[]>();
monaco.editor.onDidChangeMarkers((uris) => {
  for (const uri of uris) {
    const model = monaco.editor.getModel(uri);
    const old = typoDecorations.get(uri.toString()) ?? [];
    const typos = model && spelling.severity === "typo" ? monaco.editor.getModelMarkers({ resource: uri, owner: "lsp:typos" }) : [];
    if (!model || (!old.length && !typos.length)) continue;
    typoDecorations.set(uri.toString(), model.deltaDecorations(old, typos.map((range) => ({ range, options: { description: "typo", inlineClassName: "typo" } }))));
  }
});

const problemIcons: Record<number, string> = {
  [monaco.MarkerSeverity.Error]: "$(error)",
  [monaco.MarkerSeverity.Warning]: "$(warning)",
  [monaco.MarkerSeverity.Info]: "$(info)",
  [monaco.MarkerSeverity.Hint]: "$(info)",
};
let problemHover: monaco.IDisposable | undefined;

/**
 * Shows the problems under the pointer as formatted text. Monaco's own problem hover shows plain text in the
 * editor's font, so styles.css hides its message and keeps its View Problem and Quick Fix links. This is
 * registered again after each server's providers, since Monaco lists the newest provider's hover first. The `**`
 * pattern matches every file, in languages registered later too, as highly as a server's own language does.
 */
function registerProblemHover() {
  problemHover?.dispose();
  problemHover = monaco.languages.registerHoverProvider({ pattern: "**" }, {
    provideHover(model, pos) {
      const markers = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((m) => monaco.Range.containsPosition(m, pos))
        .sort((a, b) => b.severity - a.severity);
      if (!markers.length) return null;
      return {
        range: markers.reduce((r, m) => r.plusRange(m), monaco.Range.lift(markers[0])),
        contents: markers.map((m) => {
          const problem = { path: model.uri.fsPath, range: monaco.Range.lift(m), message: m.message, severity: m.severity, source: m.source, code: typeof m.code === "string" ? m.code : m.code?.value };
          const rule = ruleLabel(problem.source, problem.code);
          // problems.ts handles the command, which opens the problem on a page of its own.
          const open = `[Show Details](command:problems.openPage?${encodeURIComponent(JSON.stringify([problem]))} "Show the whole problem on a page")`;
          return { value: `${problemIcons[m.severity]} ${problemMarkdown(m.message)}\n\n${rule ? `\`${rule}\` · ` : ""}${open}`, supportThemeIcons: true, isTrusted: true };
        }),
      };
    },
  });
}
registerProblemHover();

// ---- PHP in Blade views ----

/** Whether the servers' Mago settings are ready, so Blade views can be checked with them. */
let bladeReady = false;

/**
 * Checks the PHP in a Blade view with Mago's analyzer (see bladephp.ts), as Tusk's server does for PHP files. Only
 * open views are checked, a second after typing stops, since Mago parses the project again for each file.
 */
async function checkBlade(model: monaco.editor.ITextModel) {
  const [root, version, path] = [projectRoot, model.getVersionId(), model.uri.fsPath];
  if (!bladeReady || model.getLanguageId() !== "blade" || !path.startsWith(`${root}/`) || isLibrary(path)) return;
  const rel = path.slice(root.length + 1);
  const php = bladeToPhp(textOf(model));
  const args = [...(magoConfigPath ? ["--config", magoConfigPath] : []), "analyze", "--stdin-input", rel, "--reporting-format", "json"];
  const json = await invoke<string>("run_capture", { cwd: root, program: await toolPath("mago/mago"), args, input: php, anyStatus: true }).catch(() => "");
  if (model.isDisposed() || root !== projectRoot || version !== model.getVersionId()) return;
  const list = realProblems(path, php, "php", magoIssuesByFile(json, "mago").get(rel)?.(php) ?? [], facts);
  monaco.editor.setModelMarkers(model, "blade", bladeProblems(list).map((d) => toMarker(d as L.Diagnostic, "blade")));
}
monaco.editor.onDidCreateModel((model) => {
  if (model.getLanguageId() !== "blade") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = model.onDidChangeContent(() => (clearTimeout(timer), (timer = setTimeout(() => checkBlade(model), 1000))));
  model.onWillDispose(() => (clearTimeout(timer), listener.dispose()));
  checkBlade(model);
});

// ---- Mago's suppressions and Fix All ----

const magoCategory: Record<string, "lint" | "analysis"> = { "mago-lint": "lint", mago: "analysis" };

/**
 * A `// @mago-expect` comment that suppresses a Mago problem on its line, and **Fix All Safe Mago Problems in File**
 * as a quick fix. Each problem's own fix comes from Tusk's server with its other code actions. Fix All asks the
 * server for `source.fixAll.mago` with the problems the editor shows, so a problem the filters drop, such as an
 * unused import that a trait's `use` needs, isn't fixed. Monaco's own Fix All reaches the server directly.
 */
monaco.languages.registerCodeActionProvider("php", {
  async provideCodeActions(model, _range, context) {
    if (context.only?.startsWith("source")) return { actions: [], dispose() {} };
    const markers = context.markers.filter((m) => magoCategory[m.source ?? ""] && typeof m.code === "string");
    const actions: monaco.languages.CodeAction[] = [];
    const lines = model.getLinesContent();
    for (const m of markers) {
      const code = m.code as string;
      const title = `Suppress ${code} for this line`;
      const expect = !/^(parse|unfulfilled-expect)$/.test(code) && magoExpect(lines, m.startLineNumber - 1, magoCategory[m.source!], code);
      if (expect && !actions.some((a) => a.title === title)) {
        actions.push({ title, kind: "quickfix", diagnostics: [m], edit: { edits: [{ resource: model.uri, textEdit: { range: toRange(expect.range), text: expect.text }, versionId: model.getVersionId() }] } });
      }
    }
    // Only when asked (⌥⏎, the problem popup), not for the light bulb's requests as the caret moves.
    if (context.trigger !== monaco.languages.CodeActionTriggerType.Invoke || !markers.some((m) => m.source === "mago-lint")) return { actions, dispose() {} };
    const shown = (lastDiagnostics.get(`lsp:tusk ${model.uri}`)?.shown ?? []).filter((d) => magoCategory[d.source ?? ""]);
    const found = await tuskRequest<L.CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri: model.uri.toString() },
      range: fromRange(model.getFullModelRange()),
      context: { diagnostics: shown, only: ["source.fixAll.mago"] },
    }).catch(() => null);
    const fixAll = found?.find((a) => a.kind === "source.fixAll.mago" && a.edit);
    if (fixAll) actions.push({ title: fixAll.title, kind: "quickfix", command: { id: "tusk.runAction", title: fixAll.title, arguments: [fixAll] } });
    return { actions, dispose() {} };
  },
}, { providedCodeActionKinds: ["quickfix"] });
monaco.editor.registerCommand("tusk.runAction", (_, action: L.CodeAction) => runTuskAction(action));

/** Converts locations and loads their files, because Monaco can only show locations in existing models. */
async function locations(result: L.Location | L.Location[] | L.LocationLink[] | null): Promise<monaco.languages.Location[]> {
  const list = !result ? [] : Array.isArray(result) ? result : [result];
  const locs = list.map((l) => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l));
  await Promise.all(locs.map((l) => host.ensureModel(pathOf(l.uri))));
  return locs.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
}

// ---- Workspace edits ----

/** Writes a model to its file and tells the servers, which update their index for open files on save. */
async function saveModel(model: monaco.editor.ITextModel) {
  const path = model.uri.fsPath;
  await writeText(path, model.getValue());
  host.markSaved(path);
  didSave(model);
}

/**
 * Makes one ⌘Z undo a refactoring in every file it changed, as PhpStorm does: undoing it in one of them undoes
 * it in the others too, and saves them all. A file edited after the refactoring leaves the group, since its
 * next undo is no longer the refactoring's.
 */
/**
 * Makes one ⌘Z undo a refactoring in every file it edited. A file the refactoring created, and the undo empties,
 * is deleted, so undoing Extract Interface leaves no empty file behind.
 */
function linkUndo(models: monaco.editor.ITextModel[], created: Map<string, string[]> = new Map()) {
  const group = new Set(models);
  if (group.size < 2) return;
  const listeners = [...group].map((model) =>
    model.onDidChangeContent((e) => {
      if (!group.has(model)) return;
      if (!e.isUndoing) return void group.delete(model);
      listeners.forEach((l) => l.dispose());
      const others = [...group].filter((m) => m !== model && !m.isDisposed());
      for (const m of others) m.undo();
      for (const m of [model, ...others]) {
        const path = m.uri.fsPath;
        // The folders the file's creation made go too, deepest first, when nothing else is in them.
        if (created.has(path) && !m.getValue())
          invoke("remove_path", { path })
            .then(async () => {
              host.forget(path);
              for (const dir of created.get(path)!) await invoke("remove_empty_dir", { path: dir });
            })
            .catch(() => {});
        else saveModel(m).catch(() => {});
      }
      host.status(`Undid the refactoring in ${others.length + 1} files.`);
    }),
  );
}

/** Applies an edit and saves every touched file, as PhpStorm does for refactorings. One ⌘Z undoes it in all of them. */
export async function applyWorkspaceEdit(edit: L.WorkspaceEdit) {
  const ops: (L.TextDocumentEdit | L.CreateFile | L.RenameFile | L.DeleteFile)[] =
    edit.documentChanges ?? Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits }));
  const edited: monaco.editor.ITextModel[] = [];
  /** Files the edit creates, with the folders it creates for them, deepest first. */
  const created = new Map<string, string[]>();
  for (const op of ops) {
    if (!("kind" in op)) {
      const model = await host.ensureModel(pathOf(op.textDocument.uri));
      // Stops on both sides keep the refactoring its own undo step, apart from typing before or after it.
      model.pushStackElement();
      model.pushEditOperations([], op.edits.map((e) => ({ range: toRange(e.range), text: "newText" in e ? e.newText : "" })), () => null);
      model.pushStackElement();
      await saveModel(model);
      edited.push(model);
    } else if (op.kind === "create") {
      // A new file never replaces one that exists, unless the edit asks to.
      const path = pathOf(op.uri);
      if (op.options?.overwrite) await invoke("write_file", { path, contents: "" });
      else {
        const folders: string[] = [];
        for (let dir = path.slice(0, path.lastIndexOf("/")); dir && !(await invoke<boolean>("path_exists", { path: dir })); dir = dir.slice(0, dir.lastIndexOf("/"))) folders.push(dir);
        const made = await invoke("create_file", { path, contents: "" }).then(
          () => true,
          (e) => {
            if (op.options?.ignoreIfExists) return false;
            throw e;
          },
        );
        if (made) created.set(path, folders);
      }
    } else if (op.kind === "rename") {
      const [from, to] = [pathOf(op.oldUri), pathOf(op.newUri)];
      await invoke("rename_path", { from, to });
      host.renamed(from, to);
    } else if (op.kind === "delete") {
      await invoke("remove_path", { path: pathOf(op.uri) });
    }
  }
  linkUndo(edited, created);
}

// Servers can link to a location with this command, for example in code lenses.
monaco.editor.registerCommand("phpEditor.open", (_, uri: string, line: number) => host.openAt(pathOf(uri), line));

// `.env` files get a language of their own, so Tusk's server can offer fixes in them.
monaco.languages.register({ id: "dotenv", filenames: [".env"], filenamePatterns: [".env.*"], aliases: ["Environment"] });

// Code actions carry the function that runs them, so each one goes back to the server that made it.
monaco.editor.registerCommand("lsp.codeAction", (_, run: (a: L.CodeAction | L.Command) => Promise<void>, action) => run(action));

const clientCapabilities: L.ClientCapabilities = {
  workspace: {
    applyEdit: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
    configuration: true,
    workspaceFolders: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
  },
  textDocument: {
    synchronization: { didSave: true },
    completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } } },
    colorProvider: {},
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
    rename: { prepareSupport: true },
    publishDiagnostics: { tagSupport: { valueSet: [1, 2] } },
    foldingRange: {},
    selectionRange: {},
    inlayHint: {},
  },
  window: { workDoneProgress: true },
};

type Server = {
  name: string;
  request<T>(method: string, params: unknown): Promise<T>;
  stop(): void;
  didSave(model: monaco.editor.ITextModel): void;
  symbols(query: string): Promise<(L.SymbolInformation | L.WorkspaceSymbol)[]>;
  willRename(files: L.FileRename[]): Promise<L.WorkspaceEdit | null>;
  executeCommand(command: string, args: unknown[]): Promise<any>;
  notify(method: string, params: unknown): void;
  /** Runs a code action or command: its edit (resolved first if the server resolves them), then its command. */
  codeAction(action: L.CodeAction | L.Command): Promise<void>;
  filesChanged(changes: L.FileEvent[]): void;
};

/**
 * Starts the bundled server `name` for the given Monaco languages. `settings` answers the
 * server's `workspace/configuration` requests, by section name.
 */
async function startServer(
  name: string,
  root: string,
  langs: string[],
  initializationOptions: object,
  settings: Record<string, unknown> = {},
  /** Handles notifications this client doesn't know, with a function to notify the server back. */
  onNotification?: (method: string, params: any, notify: (method: string, params: unknown) => void) => void,
): Promise<Server> {
  let nextId = 1;
  const pending = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
  const diagnostics = new Map<string, L.Diagnostic[]>();
  const disposables: monaco.IDisposable[] = [];
  const reg = (d: monaco.IDisposable) => disposables.push(d);
  const owner = `lsp:${name}`;
  let ready: Promise<unknown> = Promise.resolve();

  const send = (msg: object) => invoke("lsp_send", { name, msg: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
  // Anything else sent to the server first sends edits it hasn't seen, so it always answers for the current text.
  const notify = (method: string, params: any) => {
    if (method !== "textDocument/didChange") flush();
    return send({ method, params });
  };
  const call = <T>(method: string, params: unknown, token?: monaco.CancellationToken) => {
    flush();
    const id = nextId++;
    const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
    // When Monaco no longer wants the answer, such as a completion list after the next keystroke,
    // the server is told to drop the request, so a busy server gets to the current one sooner.
    const cancel = token?.onCancellationRequested(() => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      notify("$/cancelRequest", { id });
      p.resolve(null);
    });
    return send({ id, method, params }).then(() => result).finally(() => cancel?.dispose());
  };
  const request = async <T>(method: string, params: unknown, token?: monaco.CancellationToken): Promise<T> => {
    await ready;
    return token?.isCancellationRequested ? (null as T) : call<T>(method, params, token);
  };

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
      const { uri, diagnostics: list } = msg.params as L.PublishDiagnosticsParams;
      diagnostics.set(uri, list);
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model && !model.isDisposed()) {
        // Tusk's server checks every open file and publishes each check whole.
        if (name === "tusk") markDiagnosed(model);
        setMarkers(model, owner, list);
      }
    } else if (msg.method === "window/showMessage" || (msg.method === "window/logMessage" && msg.params.type === 1)) {
      host.status(`${name}: ${msg.params.message}`, name);
    } else if (onNotification && msg.method !== "$/progress") {
      onNotification(msg.method, msg.params, notify);
    } else if (msg.method === "$/progress") {
      const v = msg.params.value;
      const token = msg.params.token;
      if (v.kind === "begin") progressTitles.set(token, v.title);
      // Show progress only after it runs for a moment, so quick tasks such as resolving code
      // actions don't flash in the status bar. The percentage, when there is one, is shorter than the message.
      const text = [progressTitles.get(token), v.percentage != null ? `${Math.round(v.percentage)}%` : v.message].filter(Boolean).join(" ");
      if (v.kind === "end") {
        clearTimeout(progressTimers.get(token));
        progressTimers.delete(token);
        host.status("", `${name}:progress`);
      } else if (progressShown.has(token)) host.status(text, `${name}:progress`);
      else if (!progressTimers.has(token)) {
        progressTimers.set(token, setTimeout(() => (progressShown.add(token), host.status(text, `${name}:progress`)), 800));
      }
      if (v.kind === "end") (progressTitles.delete(token), progressShown.delete(token));
    }
  });

  async function serverRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "workspace/applyEdit":
        await applyWorkspaceEdit(params.edit);
        return { applied: true };
      case "workspace/configuration":
        return params.items.map((item: L.ConfigurationItem) => (item.section ? settings[item.section] ?? null : settings));
      case "window/showMessageRequest":
        return askUser(name, params);
      case "client/registerCapability":
        if (params.registrations.some((r: L.Registration) => r.method === "workspace/didChangeWatchedFiles")) watchesFiles = true;
        return null;
      default: // window/workDoneProgress/create and others need no work.
        return null;
    }
  }

  // `phpEditor.open` is the editor's own, such as a code action's "open the file it created".
  const execute = (cmd: L.Command) =>
    cmd.command === "phpEditor.open" ? host.openAt(pathOf(cmd.arguments![0]), cmd.arguments![1]) : request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments });

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

  const progressTitles = new Map<string | number, string>();
  const progressTimers = new Map<string | number, ReturnType<typeof setTimeout>>();
  const progressShown = new Set<string | number>();
  // Set when the server asks to hear about file changes, so its index follows moves and edits at once.
  let watchesFiles = false;

  const serves = (model: monaco.editor.ITextModel) => langs.includes(model.getLanguageId()) && model.uri.scheme === "file";

  /**
   * Servers that take whole documents, such as the Tailwind server, would otherwise get the full text and
   * reparse it on every keystroke, falling further behind on large files. Their edits wait here
   * until typing pauses, or until the next message to the server, whichever comes first.
   */
  const unsent = new Map<string, monaco.editor.ITextModel>();
  let unsentTimer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    clearTimeout(unsentTimer);
    const models = [...unsent];
    unsent.clear();
    for (const [uri, model] of models)
      if (!model.isDisposed()) notify("textDocument/didChange", { textDocument: { uri, version: model.getVersionId() }, contentChanges: [{ text: textOf(model) }] });
  }

  function track(model: monaco.editor.ITextModel) {
    if (!serves(model)) return;
    const uri = model.uri.toString();
    const sync = typeof c.textDocumentSync === "number" ? c.textDocumentSync : c.textDocumentSync?.change;
    notify("textDocument/didOpen", { textDocument: { uri, languageId: model.getLanguageId(), version: model.getVersionId(), text: textOf(model) } });
    const listener = model.onDidChangeContent((e) => {
      if (sync === 2 /* Incremental */ && !e.isFlush) {
        // Monaco orders changes from the end of the document back, so the server can apply them in turn.
        const contentChanges = e.changes.map((ch) => ({ range: fromRange(ch.range), rangeLength: ch.rangeLength, text: ch.text }));
        return notify("textDocument/didChange", { textDocument: { uri, version: e.versionId }, contentChanges });
      }
      unsent.set(uri, model);
      clearTimeout(unsentTimer);
      unsentTimer = setTimeout(flush, 150);
    });
    reg(listener);
    reg(model.onWillDispose(() => {
      unsent.delete(uri);
      listener.dispose();
      notify("textDocument/didClose", { textDocument: { uri } });
    }));
    setMarkers(model, owner, diagnostics.get(uri) ?? []);
  }

  // The backend reports a server that exits on its own, such as from a crash. One that exits while starting fails its start instead.
  let server: Server | undefined;
  const unlistenExit = await listen<string>("lsp-exit", ({ payload }) => {
    if (payload !== name) return;
    failPending(`${name} stopped`);
    if (server) serverExited(server);
  });
  const failPending = (reason: string) => {
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
  };

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
  registerProblemHover();

  server = {
    name,
    request,
    stop() {
      unlisten();
      unlistenExit();
      failPending(`${name} stopped`);
      disposables.forEach((d) => d.dispose());
      monaco.editor.getModels().forEach((m) => monaco.editor.setModelMarkers(m, owner, []));
      // So onModelsRead can't bring back the stopped server's markers.
      [...lastDiagnostics.keys()].filter((k) => k.startsWith(`${owner} `)).forEach((k) => lastDiagnostics.delete(k));
    },
    didSave(model) {
      if (serves(model)) notify("textDocument/didSave", { textDocument: { uri: model.uri.toString() } });
    },
    filesChanged(changes) {
      if (watchesFiles) notify("workspace/didChangeWatchedFiles", { changes });
    },
    executeCommand: (command, args) => request("workspace/executeCommand", { command, arguments: args }),
    notify: (method, params) => void ready.then(() => notify(method, params)),
    codeAction: runCodeAction,
    async willRename(files) {
      if (!c.workspace?.fileOperations?.willRename) return null;
      return request<L.WorkspaceEdit | null>("workspace/willRenameFiles", { files });
    },
    async symbols(query) {
      if (!c.workspaceSymbolProvider) return [];
      return (await request<(L.SymbolInformation | L.WorkspaceSymbol)[] | null>("workspace/symbol", { query })) ?? [];
    },
  };
  return server;

  function registerProviders(ml: M) {
    // The server's original item for each suggestion, sent back to resolve its details.
    const originals = new WeakMap<monaco.languages.CompletionItem, L.CompletionItem>();

    if (c.completionProvider) {
      reg(ml.registerCompletionItemProvider(langs, {
        triggerCharacters: c.completionProvider.triggerCharacters,
        async provideCompletionItems(model, pos, _context, token) {
          const res = await request<L.CompletionList | L.CompletionItem[] | null>("textDocument/completion", at(model, pos), token);
          const items = Array.isArray(res) ? res : res?.items ?? [];
          const word = model.getWordUntilPosition(pos);
          const fallback = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          return {
            incomplete: !Array.isArray(res) && !!res?.isIncomplete,
            suggestions: items.map((i) => {
              const edit = i.textEdit && ("range" in i.textEdit ? i.textEdit.range : i.textEdit.replace);
              const suggestion: monaco.languages.CompletionItem = {
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
              originals.set(suggestion, i);
              return suggestion;
            }),
          };
        },
        // Servers such as Tailwind send documentation (the generated CSS) only for the selected item.
        resolveCompletionItem: c.completionProvider.resolveProvider
          ? async (item) => {
              const original = originals.get(item);
              if (!original) return item;
              const r = await request<L.CompletionItem>("completionItem/resolve", original).catch(() => null);
              if (!r) return item;
              return {
                ...item,
                detail: r.detail ?? item.detail,
                documentation: r.documentation ? markdown(r.documentation) : item.documentation,
                additionalTextEdits: r.additionalTextEdits?.map((e) => ({ range: toRange(e.range), text: e.newText })) ?? item.additionalTextEdits,
              };
            }
          : undefined,
      }));
    }

    if (c.colorProvider) {
      reg(ml.registerColorProvider(langs, {
        async provideDocumentColors(model, token) {
          const colors = await request<L.ColorInformation[] | null>("textDocument/documentColor", doc(model), token);
          return (colors ?? []).map((ci) => ({ range: toRange(ci.range), color: ci.color }));
        },
        async provideColorPresentations(model, info) {
          const res = await request<L.ColorPresentation[] | null>("textDocument/colorPresentation", { ...doc(model), color: info.color, range: fromRange(info.range) });
          return (res ?? []).map((p) => ({ label: p.label, textEdit: p.textEdit && { range: toRange(p.textEdit.range), text: p.textEdit.newText } }));
        },
      }));
    }

    if (c.hoverProvider) {
      reg(ml.registerHoverProvider(langs, {
        async provideHover(model, pos, token) {
          const h = await request<L.Hover | null>("textDocument/hover", at(model, pos), token);
          if (!h) return null;
          const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
          if (!contents.length) return null;
          return { contents: contents.map(markdown).map((c) => ({ ...c, value: formatHoverMarkdown(c.value) })), range: h.range && toRange(h.range) };
        },
      }));
    }

    if (c.signatureHelpProvider) {
      reg(ml.registerSignatureHelpProvider(langs, {
        signatureHelpTriggerCharacters: c.signatureHelpProvider.triggerCharacters,
        signatureHelpRetriggerCharacters: c.signatureHelpProvider.retriggerCharacters,
        async provideSignatureHelp(model, pos, token) {
          const s = await request<L.SignatureHelp | null>("textDocument/signatureHelp", at(model, pos), token);
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
        async provideDocumentHighlights(model, pos, token) {
          const hs = await request<L.DocumentHighlight[] | null>("textDocument/documentHighlight", at(model, pos), token);
          return (hs ?? []).map((h) => ({ range: toRange(h.range), kind: (h.kind ?? 1) - 1 }));
        },
      }));
    }

    if (c.documentSymbolProvider) {
      reg(ml.registerDocumentSymbolProvider(langs, {
        async provideDocumentSymbols(model, token) {
          const syms = await request<(L.DocumentSymbol | L.SymbolInformation)[] | null>("textDocument/documentSymbol", doc(model), token);
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
        async provideCodeActions(model, range, context, token) {
          // Only the diagnostics left after filtering, so a dropped false problem gets no quick fix.
          const diags = lastDiagnostics.get(`${owner} ${model.uri}`)?.shown ?? [];
          // Monaco widens an empty selection to the whole problem under the cursor, which for a method-sized problem
          // takes in every problem inside it. Only the ones at the cursor then.
          const sel = monaco.editor.getEditors().find((e) => e.getModel() === model && e.hasTextFocus())?.getSelection();
          const at = sel?.isEmpty() && range.containsPosition(sel.getPosition()) ? sel : range;
          const overlapping = diags.filter((d) => monaco.Range.areIntersectingOrTouching(toRange(d.range), at));
          const res = await request<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
            ...doc(model),
            range: fromRange(range),
            context: { diagnostics: overlapping, only: context.only ? [context.only] : undefined },
          }, token);
          return {
            // typos-lsp's own "Ignore in the project" actions: spelling.ts offers the dictionaries instead.
            actions: (res ?? []).filter((a) => (typeof a.command === "string" ? a.command : a.command?.command) !== "ignore-in-project").map((a) => {
              // A bare Command has no kind. The hover's Quick Fix link lists only `quickfix` actions, so a command
              // answering problems here counts as one.
              const action = typeof a.command === "string" ? { title: a.title, kind: overlapping.length ? "quickfix" : undefined, diagnostics: overlapping } : (a as L.CodeAction);
              return {
                title: a.title,
                kind: action.kind,
                isPreferred: action.isPreferred,
                diagnostics: action.diagnostics?.map((d) => toMarker(d, owner)),
                command: { id: "lsp.codeAction", title: a.title, arguments: [runCodeAction, a] },
              };
            }),
            dispose() {},
          };
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
        async provideFoldingRanges(model, _context, token) {
          const fs = await request<L.FoldingRange[] | null>("textDocument/foldingRange", doc(model), token);
          return (fs ?? []).map((f) => ({ start: f.startLine + 1, end: f.endLine + 1, kind: f.kind ? new ml.FoldingRangeKind(f.kind) : undefined }));
        },
      }));
    }

    if (c.selectionRangeProvider) {
      reg(ml.registerSelectionRangeProvider(langs, {
        async provideSelectionRanges(model, positions, token) {
          const res = await request<L.SelectionRange[] | null>("textDocument/selectionRange", { ...doc(model), positions: positions.map(toPos) }, token);
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
        async provideInlayHints(model, range, token) {
          const hints = await request<L.InlayHint[] | null>("textDocument/inlayHint", { ...doc(model), range: fromRange(range) }, token);
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

    if (c.codeLensProvider) {
      reg(ml.registerCodeLensProvider(langs, {
        async provideCodeLenses(model, token) {
          const lenses = await request<L.CodeLens[] | null>("textDocument/codeLens", doc(model), token);
          return {
            lenses: (lenses ?? [])
              .filter((l) => l.command)
              .map((l) => ({
                range: toRange(l.range),
                command:
                  l.command!.command === "phpEditor.open"
                    ? { id: "phpEditor.open", title: l.command!.title, arguments: l.command!.arguments }
                    : { id: "lsp.codeAction", title: l.command!.title, arguments: [runCodeAction, l.command] },
              })),
            dispose() {},
          };
        },
      }));
    }

    if (c.documentLinkProvider) {
      reg(ml.registerLinkProvider(langs, {
        async provideLinks(model, token) {
          const links = await request<L.DocumentLink[] | null>("textDocument/documentLink", doc(model), token);
          return { links: (links ?? []).map((l) => ({ range: toRange(l.range), url: l.target, tooltip: l.tooltip })) };
        },
      }));
    }
  }
}

/** Every language the spell checker can check. */
export const SPELLING_LANGUAGES = ["php", "blade", "javascript", "typescript", "vue", "svelte", "astro", "markdown", "html", "css", "scss", "json", "yaml", "plaintext"];

/** Settings for the Tailwind server, which asks for the `editor` and `tailwindCSS` sections. */
const tailwindSettings = {
  editor: { tabSize: 4 },
  tailwindCSS: {
    emmetCompletions: false,
    includeLanguages: {},
    classAttributes: ["class", "className", "ngClass", "class:list", ":class"],
    classFunctions: [],
    colorDecorators: true,
    showPixelEquivalents: true,
    rootFontSize: 16,
    hovers: true,
    suggestions: true,
    codeActions: true,
    validate: true,
    lint: {
      cssConflict: "warning",
      invalidApply: "error",
      invalidScreen: "error",
      invalidVariant: "error",
      invalidConfigPath: "error",
      invalidTailwindDirective: "error",
      invalidSourceDirective: "error",
      recommendedVariantOrder: "warning",
      usedBlocklistedClass: "warning",
      suggestCanonicalClasses: "warning",
    },
    experimental: {
      // Classes in PHP arrays, as in Filament's ->extraAttributes(['class' => '...']), and in Blade's @class([...]).
      classRegex: [
        "'class'\\s*=>\\s*'([^']*)'",
        '"class"\\s*=>\\s*"([^"]*)"',
        ["@class\\(([\\s\\S]*?)\\)", "'([^']*)'"],
      ],
    },
    // Skip dependencies and hidden folders, such as git worktrees in .claude/.
    files: { exclude: ["**/.git/**", "**/node_modules/**", "**/vendor/**", "**/storage/**", "**/.*/**"] },
  },
};

/**
 * Settings for vtsls, which also loads the Vue, Svelte, and Astro TypeScript plugins from the bundled tools, so
 * TypeScript files see the types of the components they import.
 */
function typescriptSettings(nodeDir: string) {
  const language = {
    inlayHints: { parameterNames: { enabled: "literals" }, functionLikeReturnTypes: { enabled: true } },
    suggest: { completeFunctionCalls: true },
  };
  return {
    typescript: language,
    javascript: language,
    vtsls: {
      autoUseWorkspaceTsdk: true,
      tsserver: {
        globalPlugins: [
          { name: "@vue/typescript-plugin", location: nodeDir, languages: ["vue"], configNamespace: "typescript", enableForWorkspaceTypeScriptVersions: true },
          { name: "typescript-svelte-plugin", location: nodeDir, languages: ["svelte"], enableForWorkspaceTypeScriptVersions: true },
          { name: "@astrojs/ts-plugin", location: nodeDir, languages: ["astro"], enableForWorkspaceTypeScriptVersions: true },
        ],
      },
    },
  };
}

/** Monaco's built-in TypeScript features, turned off while vtsls serves JavaScript and TypeScript. Formatting is left to format.ts. */
function builtInTypeScript(enabled: boolean) {
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    const m = defaults.modeConfiguration;
    defaults.setModeConfiguration({
      ...m,
      completionItems: enabled, hovers: enabled, documentSymbols: enabled, definitions: enabled, references: enabled,
      documentHighlights: enabled, rename: enabled, diagnostics: enabled, signatureHelp: enabled, codeActions: enabled, inlayHints: enabled,
    });
  }
}

let lazyStart: monaco.IDisposable | undefined;

/**
 * Starts the TypeScript server (vtsls) when the first JavaScript, TypeScript, or Vue file
 * opens, and the Vue server when the first Vue file opens. The Vue server asks vtsls for
 * TypeScript information through `tsserver/request` notifications, which this forwards.
 * The Svelte and Astro servers run TypeScript themselves, and start with their first file. In an Angular project,
 * the Angular server starts with the first TypeScript or HTML file, for component templates in both.
 */
async function startFrontendServersLazily(root: string, start: number, angular: boolean) {
  const nodeDir = await toolPath("node");
  // A later start of the language servers replaced this one while the tool path loaded.
  if (start !== starts) return;
  let ts: Promise<Server | null> | undefined;
  let vue: Promise<Server | null> | undefined;
  const others: Record<string, Promise<Server | null>> = {};
  const tsdk = `${nodeDir}/node_modules/typescript/lib`;
  // Astro's server needs the TypeScript library's folder; Svelte's has its own copy.
  const component = { svelte: ["Svelte", {}], astro: ["Astro", { typescript: { tsdk } }] } as const;
  // A server that finishes starting after the servers restarted belongs to the old start: stop it.
  const add = (p: Promise<Server>, what: string) =>
    p.then(
      (s) => (start === starts ? (servers.push(s), s) : (s.stop(), null)),
      (e) => (host.status(`${what} server failed: ${e}`), null),
    );
  const startTs = () =>
    (ts ??= add(startServer("typescript", root, ["javascript", "typescript", "vue"], typescriptSettings(nodeDir), typescriptSettings(nodeDir)), "TypeScript").then((s) => {
      if (s) builtInTypeScript(false);
      return s;
    }));
  const startVue = () =>
    (vue ??= startTs().then((tsServer) =>
      add(
        startServer("vue", root, ["vue"], { typescript: { tsdk } }, {}, (method, params, notify) => {
          if (method !== "tsserver/request" || !tsServer) return;
          for (const [id, command, args] of params as [number, string, unknown][]) {
            tsServer
              .executeCommand("typescript.tsserverRequest", [command, args, { isAsync: true, lowPriority: true }])
              .then((res) => notify("tsserver/response", [[id, res?.body]]), () => notify("tsserver/response", [[id, null]]));
          }
        }),
        "Vue",
      ),
    ));
  const onModel = (m: monaco.editor.ITextModel) => {
    const lang = m.getLanguageId();
    if (lang === "javascript" || lang === "typescript") startTs();
    if (lang === "vue") startVue();
    if (lang === "svelte" || lang === "astro") others[lang] ??= add(startServer(lang, root, [lang], component[lang][1]), component[lang][0]);
    if (angular && (lang === "typescript" || lang === "html")) others.angular ??= add(startServer("angular", root, ["typescript", "html"], {}), "Angular");
  };
  monaco.editor.getModels().forEach(onModel);
  lazyStart = monaco.editor.onDidCreateModel(onModel);
}

let toolsReady: Promise<unknown> | undefined;

/** Waits for the language tools, which the first launch downloads. A failure is retried on the next call. */
export function ensureTools() {
  return (toolsReady ??= invoke("tools_ensure").catch((e) => ((toolsReady = undefined), Promise.reject(e))));
}

/** The path of a downloaded tool's file, such as `mago/mago`, once the tools are installed. */
export async function toolPath(name: string) {
  await ensureTools();
  return invoke<string>("tool_path", { name });
}

/** When servers exited on their own lately, so a server that crashes as it starts isn't restarted forever. */
let exits: number[] = [];

/** Restarts the servers when a running one exits on its own, up to 3 times in 5 minutes. */
function serverExited(s: Server) {
  if (!servers.includes(s)) return;
  const now = Date.now();
  exits = [...exits.filter((t) => now - t < 300_000), now];
  if (exits.length > 3) return host.status(`The ${s.name} language server keeps stopping. Reopen the project to start it again.`);
  host.status(`The ${s.name} language server stopped. Restarting it.`);
  startLsp(projectRoot, host).then(
    () => host.status(""),
    (e) => host.status(`Language servers failed to restart: ${e}`),
  );
}

/** Starts the language servers for a project, stopping those of the previous project. */
let projectRoot = "";

/** How many times the servers have started, so work from an earlier start can tell it's stale. */
let starts = 0;

export async function startLsp(root: string, h: Host) {
  await ensureTools();
  host = h;
  readModels(root);
  starts++;
  projectRoot = root;
  magoConfigPath = undefined;
  bladeReady = false;
  servers.splice(0).forEach((s) => s.stop());
  lazyStart?.dispose();
  builtInTypeScript(true);
  const exists = (path: string) => invoke<boolean>("path_exists", { path: `${root}/${path}` });
  const tool = toolPath;
  // Every check at once, rather than one round trip after another before the first server starts.
  const [magoConfig, hasMagoToml, packageJson, aliasDir, excluded] = await Promise.all([
    tool("mago.toml"),
    exists("mago.toml"),
    invoke<string>("read_file", { path: `${root}/package.json` }).catch(() => ""),
    // The index reads stubs as it builds, so a changed alias list needs a reindex.
    aliasStubs(root, () => reindex()).catch(() => null),
    exclusionsFor(root),
  ]);
  // PHP, Laravel, and Filament, from Tusk's own server (tusk-lsp/). It indexes the project as it starts, in about a
  // second, so nothing is kept between starts.
  // `.env` files too, for the server's quick fix that turns their variables into Vite ones.
  tuskInit = {
    // The project's folders to skip (indexexclude.ts), on top of the server's defaults.
    exclude: excluded.list,
    // Laravel's root aliases (`use DB;`).
    stubs: aliasDir ? [aliasDir.dir] : [],
    // Without a project mago.toml, defaults tuned for Laravel (src-tauri/resources/mago.toml).
    ...(!hasMagoToml && { magoConfig: (magoConfigPath = await projectMagoConfig(root, magoConfig, aliasDir?.dir, magoExcludes(excluded.list))) }),
  };
  const tusk = startServer("tusk", root, ["php", "blade", "dotenv"], tuskSettings(), {}, (method, params) => tuskNotifications[method]?.(params));
  bladeReady = true;
  monaco.editor.getModels().forEach(checkBlade);
  const tailwind = packageJson.includes('"tailwindcss"')
    ? startServer("tailwind", root, ["blade", "php", "html", "css", "javascript", "typescript", "vue", "svelte", "astro"], {}, tailwindSettings)
    : null;
  // Spelling in comments, strings, and names, set up by spelling.ts.
  const typos = startSpelling(root);
  startFrontendServersLazily(root, starts, packageJson.includes('"@angular/core"'));
  for (const s of await Promise.allSettled([tusk, tailwind, typos])) {
    if (s.status === "fulfilled" && s.value) servers.push(s.value);
    else if (s.status === "rejected") host.status(`Language server failed: ${s.reason}`);
  }
  checkComposerLock(root);
}

/**
 * Scans vendor for folders that declare nothing, after composer.lock changes (a project's first open included),
 * and when there are some the list doesn't skip and no earlier scan offered, says so in a toast whose Review
 * opens the dialog with the scan's result. Nothing waits for it.
 */
async function suggestExclusions(root: string) {
  const key = `indexExcludeOffered:${root}`;
  const [found, { list }] = await Promise.all([invoke<Folder[]>("symbol_free_folders", { root }).catch(() => []), exclusionsFor(root)]);
  let offered: string[];
  try {
    offered = JSON.parse(localStorage.getItem(key) ?? "[]");
    localStorage.setItem(key, JSON.stringify([...new Set([...offered, ...found.map((f) => f.path)])]));
  } catch {
    return; // Without storage, it would offer the same folders at every change.
  }
  const more = found.filter((f) => !covers(list, f.path) && !offered.includes(f.path));
  if (!more.length || root !== projectRoot) return;
  const mb = (more.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024).toFixed(1);
  toast(`Indexing can skip ${more.length} more vendor ${more.length === 1 ? "folder" : "folders"} (${mb} MB) whose PHP files declare no classes or functions.`, {
    kind: "info",
    action: { label: "Review", run: () => manageExclusions(root, found) },
  });
}

/** The Mago settings the servers use, or undefined when the project has its own mago.toml. */
export let magoConfigPath: string | undefined;

/**
 * The editor's Mago settings for a project (src-tauri/resources/mago.toml), written to the app's cache with the
 * project's PHP version, Laravel's alias stubs (`use DB;`), and copies of vendor files with the types Mago reads
 * wrong fixed (introspect.php mago-stubs) in place of the originals. Relative paths, such as `vendor`, still mean
 * the project's, since Mago runs there. The copies are made again in the background at each start, as packages
 * change; until then, the last start's are used.
 */
async function projectMagoConfig(root: string, bundled: string, aliasDir: string | undefined, excluded: string[]): Promise<string> {
  const dir = await projectCache("mago-stubs", root);
  const [text, composer, previous, top] = await Promise.all([
    invoke<string>("read_file", { path: bundled }),
    invoke<string>("read_file", { path: `${root}/composer.json` }).catch(() => "{}"),
    invoke<string>("read_file", { path: `${dir}/replaced.json` }).then(JSON.parse, () => []),
    // ponytail: a top-level folder made later is read only after the next start.
    invoke<{ name: string; is_dir: boolean }[]>("read_dir", { path: root }).catch(() => []),
  ]);
  const config = `${dir}/mago.toml`;
  const write = (replaced: string[]) =>
    invoke("write_file", { path: config, contents: magoConfigText(text, composer, [...(aliasDir ? [aliasDir] : []), ...(replaced.length ? [dir] : [])], [...excluded, ...replaced], top) });
  await invoke("create_dir", { path: dir });
  await write(previous);
  introspect(root, "mago-stubs", dir).then(async (replaced) => {
    if (!Array.isArray(replaced)) return;
    await write(replaced);
    await invoke("write_file", { path: `${dir}/replaced.json`, contents: JSON.stringify(replaced) });
    monaco.editor.getModels().forEach(checkBlade);
    // The server reads its includes and excludes from the file, which is outside the project it watches.
    if (JSON.stringify(replaced) !== JSON.stringify(previous)) reindex();
  });
  return config;
}

/**
 * Offers index exclusions when composer.lock differs from the last time the editor saw it, including installs
 * made while the editor was closed. A simple hash of the file is kept per project. The server reindexes by itself
 * when composer.lock changes.
 */
export async function checkComposerLock(root: string) {
  const lock = await invoke<string>("read_file", { path: `${root}/composer.lock` }).catch(() => null);
  let hash = 0;
  for (let i = 0; lock && i < lock.length; i++) hash = (Math.imul(31, hash) + lock.charCodeAt(i)) | 0;
  const key = `composerLock:${root}`;
  let changed = false;
  try {
    changed = lock !== null && localStorage.getItem(key) !== String(hash);
    if (changed) localStorage.setItem(key, String(hash));
  } catch {}
  // New packages may bring folders of data that the index can skip.
  if (changed) suggestExclusions(root);
}

export const didSave = (model: monaco.editor.ITextModel) => {
  servers.forEach((s) => s.didSave(model));
  // A model or a migration may have changed the models' properties.
  if (/\/(app|database)\/.*\.php$/.test(model.uri.path) && projectRoot) rereadModels(projectRoot);
};

export type Symbol = { name: string; kind: L.SymbolKind; container?: string; path: string; range?: monaco.IRange };

/** LSP symbol kinds that name types: Class, Enum, Interface, Struct (Tusk's traits). */
export const TYPE_KINDS: number[] = [5, 10, 11, 23];

/** Searches symbols across the project in every server that supports it. */
export async function workspaceSymbols(query: string): Promise<Symbol[]> {
  const results = await Promise.all(servers.map((s) => s.symbols(query).catch(() => [])));
  return results.flat().map((s) => ({
    name: s.name,
    kind: s.kind,
    container: s.containerName,
    path: pathOf(s.location.uri),
    range: "range" in s.location ? toRange(s.location.range) : undefined,
  }));
}

/** Where a class, interface, trait, or enum is declared, through the workspace symbols, matched on name and namespace. */
export async function typeSymbol(fqn: string): Promise<Symbol | undefined> {
  const short = fqn.split("\\").pop()!;
  const namespace = fqn.slice(0, -short.length - 1);
  const symbols = (await workspaceSymbols(short)).filter((s) => TYPE_KINDS.includes(s.kind));
  return symbols.find((s) => s.name === short && (s.container ?? "") === namespace) ?? symbols.find((s) => s.name === fqn);
}

/**
 * Asks the servers what to change after files moved, such as a PHP class's namespace and
 * the references to it, and applies those edits. The LSP method is `workspace/willRenameFiles`,
 * but Tusk's server reads each file at its new path, so call this after the move on disk.
 */
export async function updateReferences(renames: { from: string; to: string }[]): Promise<string | null> {
  const files = renames.map((r) => ({ oldUri: monaco.Uri.file(r.from).toString(), newUri: monaco.Uri.file(r.to).toString() }));
  let failure: string | null = null;
  for (const server of servers) {
    // A server that can't, such as one for a project without a PSR-4 map in composer.json, says why.
    const edit = await server.willRename(files).catch((e: { message?: string }) => ((failure ??= `${server.name}: ${String(e?.message ?? e)}`), null));
    if (edit) await applyWorkspaceEdit(edit);
  }
  return failure;
}

/**
 * How spelling.ts sets up the spell checker: the languages it checks, how its problems show ("typo" is a green
 * wavy underline of its own), and the user dictionary's file, which typos-lsp reads on top of the project's
 * `_typos.toml`.
 */
export const spelling = {
  languages: SPELLING_LANGUAGES,
  severity: "typo" as "typo" | "warning" | "error",
  userDictionary: async (): Promise<string | undefined> => undefined,
};

async function startSpelling(root: string) {
  if (!settings.spellCheck || !spelling.languages.length) return null;
  const config = await spelling.userDictionary().catch((e) => void host.status(`Spelling runs without your dictionary: ${e}`));
  return startServer("typos", root, spelling.languages, { diagnosticSeverity: "Info", ...(config && { config }) });
}

/** The open project's folder, or "" before one opens. */
export const spellingRoot = () => projectRoot;

/** The spell checker, when it runs. */
export const spellingServer = () => servers.find((s) => s.name === "typos");

/** Starts the spell checker again, alone, such as after a word leaves a dictionary: typos-lsp reads its files as it starts. */
export async function restartSpelling() {
  const start = starts;
  const old = spellingServer();
  if (old) (servers.splice(servers.indexOf(old), 1), old.stop());
  if (!projectRoot) return;
  const s = await startSpelling(projectRoot);
  if (s && start !== starts) return s.stop();
  if (s) servers.push(s);
}

/** Shows the spell checker's problems again, as the severity setting says. */
export function redrawSpelling() {
  lastDiagnostics.forEach(({ model, owner, list }) => owner === "lsp:typos" && !model.isDisposed() && setMarkers(model, owner, list));
}

/** The options startLsp gives Tusk's server; tuskOptions adds the other modules'. */
let tuskInit: Record<string, unknown> = {};

/**
 * Options other modules add to Tusk's server, by name, such as `phpstan` (phpstan.ts). The server reads them as it
 * starts, and configureTusk sends them again after a change, so they apply without a restart.
 */
export const tuskOptions: Record<string, () => unknown> = {};
/** Handlers for Tusk's server's own notifications, such as `tusk/phpstan`. */
export const tuskNotifications: Record<string, (params: any) => void> = {};

const tuskSettings = () => ({ ...tuskInit, ...Object.fromEntries(Object.entries(tuskOptions).map(([k, f]) => [k, f()])) });

/**
 * Sends Tusk's server its options again (`workspace/didChangeConfiguration`), with `change` applied to the
 * editor's own, such as no `magoConfig` once the project has a mago.toml. The server applies PHPStan's at once and
 * reindexes when the others changed.
 */
export function configureTusk(change: Record<string, unknown> = {}) {
  tuskInit = { ...tuskInit, ...change };
  servers.find((s) => s.name === "tusk")?.notify("workspace/didChangeConfiguration", { settings: tuskSettings() });
}

/** Sends a request to Tusk's PHP server, or returns null when it isn't running. */
export async function tuskRequest<T>(method: string, params: unknown): Promise<T | null> {
  const tusk = servers.find((s) => s.name === "tusk");
  return tusk ? tusk.request<T>(method, params) : null;
}

/** Runs a code action from Tusk's server: resolves its edit if needed, applies it, then runs its command. */
export async function runTuskAction(action: L.CodeAction | L.Command) {
  const tusk = servers.find((s) => s.name === "tusk");
  await tusk?.codeAction(action);
}

/** Builds the PHP index again, with the configuration read again, such as after mago.toml or the stubs change. */
export function reindex() {
  tuskRequest("tusk/reindex", {}).catch((e) => host.status(`Can't reindex: ${e}`));
}

/** The project's list, whether it's shared in `tusk.json`, and whether anyone ever set it. */
async function exclusionsFor(_root: string): Promise<{ list: string[]; shared: boolean; set: boolean }> {
  const list = projectValue<unknown>("indexExclude");
  const valid = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : undefined;
  return { list: valid ?? DEFAULT_EXCLUDES, shared: projectScope("indexExclude") === "shared", set: !!valid };
}

/** Saves the list to `tusk.json` when `shared`, otherwise on this Mac, and removes it from the other place. */
async function saveExclusions(_root: string, list: string[], shared: boolean) {
  await setProjectValue("indexExclude", list, shared ? "shared" : "local");
}

// A changed list in tusk.json, such as after git pull, restarts the servers with it.
onProjectValue("indexExclude", () => void (projectRoot && startLsp(projectRoot, host).catch((e) => host.status(`Can't restart the language servers: ${e}`))));

/** Saves the project's list of folders to skip, and restarts the servers with it. */
export async function setExclusions(list: string[], shared: boolean) {
  const root = projectRoot;
  await saveExclusions(root, list, shared);
  await startLsp(root, host);
}

/** Opens the Index Exclusions dialog, and reindexes when the list changes. */
export async function manageExclusions(root: string, found?: Folder[]) {
  const chosen = await editExclusions({ root, ...(await exclusionsFor(root)), found });
  if (chosen) await setExclusions(chosen.list, chosen.shared).catch((e) => host.status(`Can't save index exclusions: ${e}`));
}

/**
 * Whether a folder, relative to the project, is skipped: "entry" when the list names it, so it can be taken
 * out, "covered" when it's inside a folder the list names or matches a glob, and "no" otherwise.
 */
export async function exclusionOf(root: string, rel: string): Promise<"entry" | "covered" | "no"> {
  const { list } = await exclusionsFor(root);
  return list.includes(rel) ? "entry" : covers(list, rel) ? "covered" : "no";
}

/** Adds a folder to the project's list, or takes it out, and reindexes. */
export async function excludeFolder(root: string, rel: string, exclude: boolean) {
  const { list, shared } = await exclusionsFor(root);
  await setExclusions(exclude ? [...list, rel] : list.filter((p) => p !== rel), shared).catch((e) => host.status(`Can't save index exclusions: ${e}`));
}

/**
 * Tells the servers which files changed on disk: PHP files for the index, and the others Tusk's server watches
 * for Laravel's facts, such as `.env`, `composer.lock`, and `mago.toml`. `exists` false means deleted.
 */
export function filesChanged(files: { path: string; exists: boolean }[]) {
  const watched = files.filter((f) => /\.php$|\/\.env$|\/composer\.lock$|\/mago\.toml$|\/lang\/.*\.json$|\/public\//.test(f.path));
  // Created and changed look the same here; the server reads the file either way.
  const changes = watched.map((f): L.FileEvent => ({ uri: monaco.Uri.file(f.path).toString(), type: f.exists ? 2 : 3 }));
  if (changes.length) servers.forEach((s) => s.filesChanged(changes));
}

