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
import { isDeprecation, isUnused, magoConfigText, magoExpect, magoFixes, problemMarkdown, realProblems, ruleLabel, safeEdits, severityOf, type MagoFix } from "./diagnostics";

type M = typeof monaco.languages;

/** What the LSP client needs from the rest of the app. */
export type Host = {
  /** Returns the model for a file, loading it from disk if needed. */
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  /** Records that the model's current text is on disk. */
  markSaved(path: string): void;
  /** Moves an open tab after a file is renamed on disk. */
  renamed(from: string, to: string): void;
  /** Opens a file at a 1-based line. */
  openAt(path: string, line: number): void;
  /** Shows a status message; each source has its own slot, and "" clears it. */
  status(text: string, source?: string): void;
};

let host: Host;
const servers: Server[] = [];

/**
 * Shows a server's question in the picker and returns the chosen action, or null if dismissed.
 * Phpactor asks this way, for example whether to trust a project's .phpactor.json.
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
 * Files Phpactor has checked since they opened, whose markers from it and Mago are current. The Problems panel
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
  ...(owner === "lsp:typos"
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
    const typos = model ? monaco.editor.getModelMarkers({ resource: uri, owner: "lsp:typos" }) : [];
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

// ---- Mago's fixes and suppressions ----

/** Mago's lint of a model's text, run once per version. Phpactor's Mago extension drops the fixes Mago reports. */
const magoLints = new WeakMap<monaco.editor.ITextModel, { version: number; fixes: Promise<MagoFix[]> }>();
function magoFixesOf(model: monaco.editor.ITextModel): Promise<MagoFix[]> {
  const version = model.getVersionId();
  let lint = magoLints.get(model);
  if (lint?.version !== version) {
    const text = textOf(model);
    const args = [...(magoConfigPath ? ["--config", magoConfigPath] : []), "lint", "--stdin-input", model.uri.fsPath.slice(projectRoot.length + 1), "--reporting-format", "json"];
    const fixes = toolPath("mago/mago")
      .then((mago) => invoke<string>("run_capture", { cwd: projectRoot, program: mago, args, input: text, anyStatus: true }))
      .then((json) => magoFixes(json, text))
      .catch((e) => (host.status(`Mago lint failed: ${e}`), []));
    magoLints.set(model, (lint = { version, fixes }));
  }
  return lint.fixes;
}

const magoCategory: Record<string, "lint" | "analysis"> = { "mago-lint": "lint", mago: "analysis" };

/**
 * Quick fixes for Mago's problems: its own fix (labelled when it may change behavior), all its safe fixes in the
 * file (also Monaco's Fix All), and a `// @mago-expect` comment that suppresses the problem on its line.
 */
monaco.languages.registerCodeActionProvider("php", {
  async provideCodeActions(model, range, context) {
    const fixAll = context.only?.startsWith("source.fixAll") ?? false;
    const markers = (fixAll ? monaco.editor.getModelMarkers({ resource: model.uri }) : context.markers).filter((m) => magoCategory[m.source ?? ""] && typeof m.code === "string");
    const actions: monaco.languages.CodeAction[] = [];
    // The version the edits are for, taken before Mago runs, so Monaco refuses them if the text changes meanwhile.
    const versionId = model.getVersionId();
    const edit = (edits: { range: L.Range; text: string }[]) => ({ edits: edits.map((e) => ({ resource: model.uri, textEdit: { range: toRange(e.range), text: e.text }, versionId })) });
    if (!fixAll) {
      const lines = model.getLinesContent();
      for (const m of markers) {
        const code = m.code as string;
        const title = `Suppress ${code} for this line`;
        const expect = !/^(parse|unfulfilled-expect)$/.test(code) && magoExpect(lines, m.startLineNumber - 1, magoCategory[m.source!], code);
        if (expect && !actions.some((a) => a.title === title)) actions.push({ title, kind: "quickfix", diagnostics: [m], edit: edit([expect]) });
      }
    }
    // Mago runs only when asked (⌥⏎, the problem popup, Fix All), not for the light bulb's requests as the caret moves.
    const lint = markers.filter((m) => m.source === "mago-lint");
    if (context.trigger !== monaco.languages.CodeActionTriggerType.Invoke || !lint.length || !projectRoot || !model.uri.fsPath.startsWith(`${projectRoot}/`)) return { actions, dispose() {} };
    const fixes = await magoFixesOf(model);
    if (!fixAll) {
      for (const f of fixes.filter((f) => monaco.Range.areIntersectingOrTouching(toRange(f.range), range))) {
        const diagnostics = lint.filter((m) => m.code === f.code && monaco.Range.areIntersectingOrTouching(m, toRange(f.range)));
        if (!diagnostics.length) continue;
        const risk = f.safety === "unsafe" ? " (unsafe)" : f.safety === "potentiallyunsafe" ? " (may change behavior)" : "";
        actions.unshift({ title: `${f.title}${risk}`, kind: "quickfix", isPreferred: !risk, diagnostics, edit: edit(f.edits) });
      }
    }
    // Only fixes for problems the editor shows: the filters drop some of Mago's, such as an import a trait uses.
    const shown = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.source === "mago-lint");
    const safe = safeEdits(fixes.filter((f) => shown.some((m) => m.code === f.code && monaco.Range.areIntersectingOrTouching(m, toRange(f.range)))));
    if (safe.length) actions.push({ title: "Fix All Safe Mago Problems in File", kind: fixAll ? "source.fixAll.mago" : "quickfix", edit: edit(safe) });
    return { actions, dispose() {} };
  },
}, { providedCodeActionKinds: ["quickfix", "source.fixAll.mago"] });

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
      await writeText(path, model.getValue());
      host.markSaved(path);
      // Servers update their index for open files on save, so reference lookups see these edits.
      didSave(model);
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

// Servers can link to a location with this command, for example in code lenses.
monaco.editor.registerCommand("phpEditor.open", (_, uri: string, line: number) => host.openAt(pathOf(uri), line));

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
    if (/^textDocument\/did(Open|Change|Save)$/.test(method)) lastEnqueued = params.textDocument.uri;
    return send({ method, params });
  };
  /** The document Phpactor checks next: the one its diagnostics engine keeps waiting (see checkOneByOne). */
  let lastEnqueued = "";
  /** Whether an indexing run has ended since the server started (see the $/progress handler). */
  let indexedOnce = false;
  /** Phpactor's empty publishes waiting to apply, by document (see the publishDiagnostics handler). */
  const heldClears = new Map<string, ReturnType<typeof setTimeout>>();
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
      clearTimeout(heldClears.get(uri));
      heldClears.delete(uri);
      // Read now: a held publish applies after you may have moved on to another file.
      const enqueued = name === "phpactor" && uri === lastEnqueued;
      const apply = () => {
        if (!model || model.isDisposed()) return;
        if (enqueued) markDiagnosed(model);
        setMarkers(model, owner, list);
      };
      // Phpactor publishes an empty list before each check, then the list so far as each checker finishes, and
      // nothing more for a checker that found nothing. Keeping the old markers until the check is likely done stops
      // them from vanishing and coming back after each pause in typing.
      // ponytail: held markers keep their old ranges (Monaco moves the squiggles, not the markers the Problems panel
      // reads); read ranges from the decorations if that shows.
      if (name === "phpactor" && !list.length && lastDiagnostics.get(`${owner} ${uri}`)?.shown.length) heldClears.set(uri, setTimeout(apply, 4000));
      else apply();
      published.get(uri)?.(list);
    } else if (msg.method === "window/showMessage" || (msg.method === "window/logMessage" && msg.params.type === 1)) {
      host.status(`${name}: ${msg.params.message}`, name);
      // Phpactor asks for a restart after you trust a project's .phpactor.json.
      if (/restart the language server/i.test(msg.params.message)) setTimeout(() => startLsp(root, host), 500);
    } else if (onNotification && msg.method !== "$/progress") {
      onNotification(msg.method, msg.params, notify);
    } else if (msg.method === "$/progress") {
      const v = msg.params.value;
      const token = msg.params.token;
      if (v.kind === "begin") progressTitles.set(token, v.title);
      // The first indexing run after a full reindex request is the full build; its end means the index is complete.
      if (name === "phpactor" && v.kind === "begin" && awaitingFullIndex && /^indexing/i.test(v.title ?? "")) (fullIndexRun = token), (awaitingFullIndex = false);
      if (name === "phpactor" && v.kind === "end" && token === fullIndexRun) (fullIndexRun = undefined), markIndexComplete(root);
      // Show progress only after it runs for a moment, so quick tasks such as resolving code
      // actions don't flash in the status bar.
      const text = [progressTitles.get(token), v.message ?? (v.percentage != null && `${v.percentage}%`)].filter(Boolean).join(" ");
      if (v.kind === "end") {
        clearTimeout(progressTimers.get(token));
        progressTimers.delete(token);
        host.status("", `${name}:progress`);
      } else if (progressShown.has(token)) host.status(text, `${name}:progress`);
      else if (!progressTimers.has(token)) {
        progressTimers.set(token, setTimeout(() => (progressShown.add(token), host.status(text, `${name}:progress`)), 800));
      }
      // Only the first indexing run: later ones follow a file created or changed on disk, and a pass over every open
      // file would take Phpactor's one waiting check away from the file you're editing for a minute.
      if (v.kind === "end" && !indexedOnce && /^indexing/i.test(progressTitles.get(token) ?? "")) (indexedOnce = true), recheckOpenFiles();
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

  const progressTitles = new Map<string | number, string>();
  const progressTimers = new Map<string | number, ReturnType<typeof setTimeout>>();
  const progressShown = new Set<string | number>();
  // Set when the server asks to hear about file changes. Phpactor then relies on the editor
  // instead of polling the disk every few seconds, so its index follows moves and edits at once.
  let watchesFiles = false;

  /**
   * Files opened during indexing were checked against a partial index, so names defined in
   * files not yet indexed (such as Laravel's config() helper) show as not found. Phpactor
   * doesn't recheck them when indexing ends, so a save notification asks it to.
   */
  const recheckOpenFiles = () => checkOneByOne(monaco.editor.getModels().filter(serves));

  /**
   * Phpactor's diagnostics engine keeps one waiting document: each document opened, changed, or saved replaces
   * the one before, and the engine drops a document's results once another is waiting. So when a session reopens
   * several files, only the last got checked. This asks for one file at a time, each once the one before has
   * published results from both Mago checkers (plus half a second), or has been quiet for 5 seconds since its last
   * publish (Mago takes about 2, and a checker that finds nothing publishes nothing), or after 30 seconds. A newer
   * pass stops an older one.
   */
  let checkRun = 0;
  const published = new Map<string, (list: L.Diagnostic[]) => void>();
  async function checkOneByOne(models: monaco.editor.ITextModel[]) {
    const run = ++checkRun;
    for (const model of models) {
      if (run !== checkRun) return;
      if (model.isDisposed()) continue;
      const uri = model.uri.toString();
      await new Promise<void>((resolve) => {
        const done = () => (clearTimeout(timer), published.delete(uri), resolve());
        let timer = setTimeout(done, 30000);
        published.set(uri, (list) => {
          clearTimeout(timer);
          const sources = new Set(list.map((d) => d.source));
          timer = setTimeout(done, sources.has("mago") && sources.has("mago-lint") ? 500 : 5000);
        });
        notify("textDocument/didSave", { textDocument: { uri } });
      });
    }
  }

  const serves = (model: monaco.editor.ITextModel) => langs.includes(model.getLanguageId()) && model.uri.scheme === "file";

  /**
   * Servers that take whole documents, such as Phpactor, would otherwise get the full text and
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
  // A session's files open together, and Phpactor checks only the last of them (see checkOneByOne).
  if (name === "phpactor") checkOneByOne(monaco.editor.getModels().filter(serves));
  registerProviders(monaco.languages);
  registerProblemHover();

  return {
    name,
    request,
    stop() {
      unlisten();
      heldClears.forEach(clearTimeout);
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
    async willRename(files) {
      if (!c.workspace?.fileOperations?.willRename) return null;
      return request<L.WorkspaceEdit | null>("workspace/willRenameFiles", { files });
    },
    async symbols(query) {
      if (!c.workspaceSymbolProvider) return [];
      return (await request<(L.SymbolInformation | L.WorkspaceSymbol)[] | null>("workspace/symbol", { query })) ?? [];
    },
  };

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
          // Phpactor answers for a docblock with its parser's node name, such as `ClassMembersNode`.
          const contents = (Array.isArray(h.contents) ? h.contents : [h.contents]).filter((c) => !/^\s*[A-Z]\w*Node\s*$/.test(typeof c === "string" ? c : c.value));
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
          const overlapping = diags.filter((d) => monaco.Range.areIntersectingOrTouching(toRange(d.range), range));
          const res = await request<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
            ...doc(model),
            range: fromRange(range),
            context: { diagnostics: overlapping, only: context.only ? [context.only] : undefined },
          }, token);
          return {
            actions: (res ?? []).map((a) => {
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

/**
 * Phpactor's indexer ignores .gitignore, so without these patterns it walks copies of the
 * project in hidden folders (such as git worktrees under .claude/ or .idea/), node_modules,
 * and compiled views, and lists every class several times.
 */
const phpactorIndexer = {
  "indexer.exclude_patterns": [
    // Phpactor's defaults, which this list replaces.
    "/vendor/**/Tests/**/*",
    "/vendor/**/tests/**/*",
    "/vendor/composer/**/*",
    "/vendor/rector/rector/stubs-rector",
    "/.*/**/*",
    "/node_modules/**/*",
    "/storage/**/*",
    "/bootstrap/cache/**/*",
  ],
  // Phpactor keeps entries for files that later become excluded. Bump the suffix whenever
  // the patterns change, so projects get a fresh index instead of stale duplicates.
  // -editor-2: indexes built before full builds were tracked may be missing whole folders of vendor.
  "indexer.index_path": "%cache%/index/%project_id%-editor-2",
};
/** The editor's index, for running Phpactor's command line against the same index as the server. */
export const PHPACTOR_INDEX = { "indexer.index_path": phpactorIndexer["indexer.index_path"] };

const SPELLING_LANGUAGES = ["php", "blade", "javascript", "typescript", "vue", "svelte", "astro", "markdown", "html", "css", "scss", "json", "yaml", "plaintext"];

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
  servers.splice(0).forEach((s) => s.stop());
  lazyStart?.dispose();
  builtInTypeScript(true);
  const exists = (path: string) => invoke<boolean>("path_exists", { path: `${root}/${path}` });
  const tool = toolPath;
  // Every check at once, rather than one round trip after another before the first server starts.
  const [magoBin, magoConfig, hasMagoToml, hasPhpstan, hasArtisan, hasFilament, packageJson, phar, aliasDir] = await Promise.all([
    tool("mago/mago"),
    tool("mago.toml"),
    exists("mago.toml"),
    exists("vendor/bin/phpstan"),
    exists("artisan"),
    exists("vendor/filament/filament"),
    invoke<string>("read_file", { path: `${root}/package.json` }).catch(() => ""),
    tool("phpactor/phpactor.phar"),
    // Phpactor indexes stub paths only once, so a changed alias list needs a full reindex.
    aliasStubs(root, () => reindex()).catch(() => null),
  ]);
  const phpactor = startServer("phpactor", root, ["php"], {
    ...phpactorIndexer,
    // PHP's own stubs, which this list replaces, and Laravel's root aliases (`use DB;`).
    "indexer.stub_paths": [`phar://${phar}/vendor/jetbrains/phpstorm-stubs`, ...(aliasDir ? [aliasDir.dir] : [])],
    // Phpactor otherwise runs diagnostics in a child process that reads only .phpactor.json, not these
    // settings, so it would use the default index path and report functions from newer packages as not found.
    "language_server.diagnostic_outsource": false,
    "language_server_worse_reflection.inlay_hints.enable": true,
    "language_server_worse_reflection.inlay_hints.types": true,
    "language_server_worse_reflection.inlay_hints.params": true,
    "language_server_mago.enabled": true,
    "language_server_mago.bin": magoBin,
    // Without a project mago.toml, use defaults tuned for Laravel (src-tauri/resources/mago.toml).
    ...(!hasMagoToml && { "language_server_mago.config": (magoConfigPath = await projectMagoConfig(root, magoConfig, aliasDir?.dir)) }),
    "language_server_phpstan.enabled": hasPhpstan,
  });
  const laravel = hasArtisan ? startServer("laravel", root, ["php", "blade"], {}) : null;
  const filament = hasFilament ? startServer("filament", root, ["php"], {}) : null;
  const tailwind = packageJson.includes('"tailwindcss"')
    ? startServer("tailwind", root, ["blade", "php", "html", "css", "javascript", "typescript", "vue", "svelte", "astro"], {}, tailwindSettings)
    : null;
  // Spelling in comments, strings, and names. Words the project uses on purpose go in _typos.toml.
  const typos = settings.spellCheck
    ? startServer("typos", root, SPELLING_LANGUAGES, { diagnosticSeverity: "Info" })
    : null;
  startFrontendServersLazily(root, starts, packageJson.includes('"@angular/core"'));
  for (const s of await Promise.allSettled([phpactor, laravel, filament, tailwind, typos])) {
    if (s.status === "fulfilled" && s.value) servers.push(s.value);
    else if (s.status === "rejected") host.status(`Language server failed: ${s.reason}`);
  }
  // New alias stubs get into the index only with a full build.
  if (aliasDir?.fresh) reindex();
  else checkComposerLock(root);
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
async function projectMagoConfig(root: string, bundled: string, aliasDir: string | undefined): Promise<string> {
  const dir = await projectCache("mago-stubs", root);
  const [text, composer, previous] = await Promise.all([
    invoke<string>("read_file", { path: bundled }),
    invoke<string>("read_file", { path: `${root}/composer.json` }).catch(() => "{}"),
    invoke<string>("read_file", { path: `${dir}/replaced.json` }).then(JSON.parse, () => []),
  ]);
  const config = `${dir}/mago.toml`;
  const write = (replaced: string[]) =>
    invoke("write_file", { path: config, contents: magoConfigText(text, composer, [...(aliasDir ? [aliasDir] : []), ...(replaced.length ? [dir] : [])], replaced) });
  await invoke("create_dir", { path: dir });
  await write(previous);
  introspect(root, "mago-stubs", dir).then(async (replaced) => {
    if (!Array.isArray(replaced)) return;
    await write(replaced);
    await invoke("write_file", { path: `${dir}/replaced.json`, contents: JSON.stringify(replaced) });
  });
  return config;
}

/**
 * Reindexes when composer.lock differs from the last time the editor saw it, including installs made
 * while the editor was closed. A simple hash of the file is kept per project.
 */
export async function checkComposerLock(root: string) {
  // An index whose full build never finished is missing files, and Phpactor's update pass won't add them.
  if (!indexComplete(root)) return reindex();
  const lock = await invoke<string>("read_file", { path: `${root}/composer.lock` }).catch(() => null);
  if (lock === null) return;
  let hash = 0;
  for (let i = 0; i < lock.length; i++) hash = (Math.imul(31, hash) + lock.charCodeAt(i)) | 0;
  const key = `composerLock:${root}`;
  try {
    if (localStorage.getItem(key) === String(hash)) return;
    localStorage.setItem(key, String(hash));
  } catch {
    return; // Without storage, don't reindex on every start.
  }
  reindex();
}

/**
 * Whether Phpactor's index for a project was ever built to the end. Its first build takes minutes, and if the
 * server stops partway (a restart, or opening another project), later starts only index files changed since
 * the last update, which any change moves forward; the files the first build never reached stay missing, and
 * functions such as Laravel's response() show as not found. So until a full build ends, each start asks for one.
 */
const indexedKey = (root: string) => `phpactorIndexed:${root}`;
function indexComplete(root: string) {
  try {
    return localStorage.getItem(indexedKey(root)) === phpactorIndexer["indexer.index_path"];
  } catch {
    return true; // Without storage, don't rebuild on every start.
  }
}
function markIndexComplete(root: string) {
  try {
    localStorage.setItem(indexedKey(root), phpactorIndexer["indexer.index_path"]);
  } catch {}
}
/** A full reindex was asked for and hasn't started; then the progress token of the run that is the full build. */
let awaitingFullIndex = false;
let fullIndexRun: unknown;

export const didSave = (model: monaco.editor.ITextModel) => {
  servers.forEach((s) => s.didSave(model));
  // A model or a migration may have changed the models' properties.
  if (/\/(app|database)\/.*\.php$/.test(model.uri.path) && projectRoot) rereadModels(projectRoot);
};

export type Symbol = { name: string; kind: L.SymbolKind; container?: string; path: string; range?: monaco.IRange };

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

/**
 * Asks the servers what to change after files moved, such as a PHP class's namespace and
 * the references to it, and applies those edits. The LSP method is `workspace/willRenameFiles`,
 * but Phpactor reads each file at its new path, so call this after the move on disk.
 */
export async function updateReferences(renames: { from: string; to: string }[]) {
  const files = renames.map((r) => ({ oldUri: monaco.Uri.file(r.from).toString(), newUri: monaco.Uri.file(r.to).toString() }));
  for (const server of servers) {
    const edit = await server.willRename(files).catch(() => null);
    if (edit) await applyWorkspaceEdit(edit);
  }
}

/** Sends a request to Phpactor, or returns null when it isn't running. */
export async function phpactorRequest<T>(method: string, params: unknown): Promise<T | null> {
  const phpactor = servers.find((s) => s.name === "phpactor");
  return phpactor ? phpactor.request<T>(method, params) : null;
}

/**
 * Rebuilds Phpactor's index from scratch. Needed after Composer installs packages: their files keep the
 * package's old modification times, so Phpactor's update pass takes them for already indexed. A soft
 * reindex only indexes files modified since the last pass.
 */
export function reindex(soft = false) {
  const phpactor = servers.find((s) => s.name === "phpactor");
  if (!soft && phpactor) awaitingFullIndex = true;
  phpactor?.request("phpactor/indexer/reindex", { soft }).catch((e) => host.status(`Can't reindex: ${e}`));
}

let reindexTimer: ReturnType<typeof setTimeout> | undefined;

/** Tells the servers which PHP files changed on disk. `exists` false means deleted. */
export function filesChanged(files: { path: string; exists: boolean }[]) {
  const php = files.filter((f) => f.path.endsWith(".php"));
  const changes = php.map((f): L.FileEvent => ({ uri: monaco.Uri.file(f.path).toString(), type: f.exists ? 2 : 3 }));
  if (changes.length) servers.forEach((s) => s.filesChanged(changes));
  // Phpactor's index misses PHP files that another program creates or changes, such as make:model or a git
  // checkout, even with the events above. Files open in the editor reach it through the editor, so only
  // files without a model, outside the folders the index skips, need a (soft) reindex.
  const external = php.some(
    (f) => f.exists && !monaco.editor.getModel(monaco.Uri.file(f.path)) && !/\/(vendor|node_modules|storage|bootstrap\/cache|\.[^/]+)\//.test(f.path.slice(projectRoot.length)),
  );
  // Until a full build has finished, one is running or comes with the next start; an update pass would only
  // move the index's timestamp past the files it's missing.
  if (!external || !indexComplete(projectRoot)) return;
  clearTimeout(reindexTimer);
  reindexTimer = setTimeout(() => reindex(true), 2000);
}
