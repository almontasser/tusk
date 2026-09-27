// Sync with Routes: brings an .http file's requests in line with the Laravel app's routes. It lists what would
// change (a request for each new route, bodies whose validation rules changed, and requests no route answers any
// more), each with a checkbox, and changes the file only when you apply them. The file then saves, unless it had
// unsaved edits, which stay unsaved with the sync.
import { h, icon } from "./dom";
import { monaco } from "./editor";
import { host } from "./httpclient";
import { applyLineEdits, type LineEdit, matchRoute, parseHttp, type Route, routeSync, type SyncChange, syncEdits } from "./httpfile";
import { appRoutes, dropTabsIn, httpFiles, openRequest, refreshRequestTabs, refreshTree, routesList, showHttpPanel } from "./httpview";
import { pick } from "./palette";
import { routeRules } from "./runner";

type Scope = "api" | "all";

const view = h("div", { class: "http-client http-sync" });
const relative = (path: string) => path.replace(host.root() + "/", "");

/** The sync on show: its file, the routes in scope, what would change, and which changes are ticked. */
let state: {
  path: string;
  scope: Scope;
  routes: Route[];
  all: Route[];
  rules: Map<string, Record<string, string>>;
  version: number;
  changes: SyncChange[];
  picked: Set<SyncChange>;
  done?: string;
} | null = null;

/** Opens the sync for a file, asking which one when there's no `path`. */
export async function syncWithRoutes(path?: string): Promise<void> {
  if (!host.root()) return;
  if (!path) {
    const files = await httpFiles().catch(() => []);
    if (!files.length) return host.status("There are no .http files to sync. Create requests from your routes first.");
    return pick("Sync which .http file with the Laravel routes?", () => files.map((f) => ({ label: relative(f), icon: "codicon-globe", run: () => syncWithRoutes(f) })));
  }
  showHttpPanel("Sync with Routes", view);
  loading(`Reading routes from artisan route:list for ${relative(path)}…`);
  let all: Route[];
  try {
    all = appRoutes(await routesList(true));
  } catch (e) {
    return failed(path, `Couldn't list the routes: ${e instanceof Error ? e.message : String(e).trim()}`);
  }
  loading("Reading each route's validation rules…");
  // Rules for the routes that take a body, from each controller's FormRequest or validate() call.
  const rules = new Map<string, Record<string, string>>();
  await Promise.all(
    all.filter((r) => /POST|PUT|PATCH/.test(r.method)).map(async (r) => rules.set(r.action, await routeRules(r.action).catch(() => ({})))),
  );
  const model = await host.ensureModel(path);
  state = { path, scope: scopeOf(model.getValue(), all), routes: [], all, rules, version: 0, changes: [], picked: new Set() };
  compute(model);
  render();
}

const isApi = (r: Route) => r.uri.startsWith("api/");

/** The routes a file covers, going by those it calls: only API routes, unless it calls others too or there are none. */
function scopeOf(text: string, all: Route[]): Scope {
  if (!all.some(isApi)) return "all";
  const calls = parseHttp(text).requests.map((r) => matchRoute(r.method, r.url, all));
  return calls.some((route) => route && !isApi(route)) ? "all" : "api";
}

/** Works out the changes for the file's current text; they start ticked, except deletions. */
function compute(model: monaco.editor.ITextModel) {
  if (!state) return;
  state.routes = state.scope === "api" ? state.all.filter(isApi) : state.all;
  state.version = model.getVersionId();
  // Requests for routes outside the scope aren't gone, so they aren't offered for deletion.
  const all = state.all;
  state.changes = routeSync(model.getValue(), state.routes, state.rules).filter((c) => c.kind !== "remove" || !matchRoute(c.request.method, c.request.url, all));
  state.picked = new Set(state.changes.filter((c) => c.kind !== "remove"));
}

function loading(text: string) {
  view.replaceChildren(h("div", { class: "http-empty" }, h("p", {}, icon("loading codicon-modifier-spin"), " ", text)));
}

function failed(path: string, message: string) {
  view.replaceChildren(
    h("div", { class: "http-empty" }, h("p", { class: "http-error" }, message), h("div", { class: "http-empty-actions" }, h("button", { class: "primary", onclick: () => syncWithRoutes(path) }, "Try Again"))),
  );
}

const GROUPS: { kind: SyncChange["kind"]; title: string; hint: string }[] = [
  { kind: "add", title: "New routes", hint: "Each gets a request, with a body from its validation rules." },
  { kind: "update", title: "Changed bodies", hint: "Fields the rules add get an example value; fields no rule validates go. Your values stay." },
  { kind: "remove", title: "No matching route", hint: "No route answers these requests any more. Tick the ones to delete." },
];

function render() {
  if (!state) return;
  const s = state;
  const scopeButton = (scope: Scope, label: string) =>
    h("button", {
      textContent: label,
      ariaPressed: String(s.scope === scope),
      onclick: async () => {
        if (s.scope === scope) return;
        s.scope = scope;
        s.done = undefined;
        compute(await host.ensureModel(s.path));
        render();
      },
    });
  const api = s.all.filter(isApi).length;
  const picked = s.changes.filter((c) => s.picked.has(c));
  const apply = h("button", { class: "primary", disabled: !picked.length, onclick: () => applyPicked() }, picked.length ? `Apply ${picked.length} ${picked.length === 1 ? "Change" : "Changes"}` : "Apply");
  const bar = h(
    "div",
    { class: "http-bar http-sync-bar" },
    h("strong", {}, `Sync ${relative(s.path)} with the Laravel routes`),
    api && api < s.all.length ? h("div", { class: "segmented" }, scopeButton("api", `API routes (${api})`), scopeButton("all", `All routes (${s.all.length})`)) : null,
    h("span", { class: "http-spacer" }),
    h("button", { title: "Read the routes and rules again", onclick: () => syncWithRoutes(s.path) }, icon("refresh"), " Refresh"),
    h("button", { disabled: !picked.length, title: "Show the file before and after the ticked changes", onclick: () => showDiff() }, icon("diff"), " View Diff"),
    apply,
  );
  if (!s.changes.length) {
    view.replaceChildren(
      bar,
      h(
        "div",
        { class: "http-empty" },
        h("p", {}, icon("pass"), " ", s.done ?? `${relative(s.path)} is in step with ${s.routes.length} ${s.scope === "api" ? "API " : ""}routes.`),
        s.done ? h("p", { class: "http-hint" }, `It's in step with ${s.routes.length} ${s.scope === "api" ? "API " : ""}routes now.`) : null,
      ),
    );
    return;
  }
  const groups = GROUPS.map(({ kind, title, hint }) => {
    const list = s.changes.filter((c) => c.kind === kind);
    if (!list.length) return null;
    const all = h("input", { type: "checkbox", title: "Tick all", ariaLabel: `Tick all ${title.toLowerCase()}` });
    all.checked = list.every((c) => s.picked.has(c));
    all.indeterminate = !all.checked && list.some((c) => s.picked.has(c));
    all.onchange = () => (list.forEach((c) => (all.checked ? s.picked.add(c) : s.picked.delete(c))), render());
    return h(
      "section",
      { class: `http-sync-group ${kind}` },
      h("label", { class: "http-sync-head" }, all, h("strong", {}, title), h("span", { class: "muted" }, String(list.length)), h("span", { class: "http-hint" }, hint)),
      h("ul", {}, ...list.map((c) => row(c))),
    );
  });
  view.replaceChildren(bar, s.done ? h("p", { class: "http-sync-done" }, icon("pass"), " ", s.done) : "", h("div", { class: "http-sync-list" }, ...groups));
}

function row(c: SyncChange) {
  const s = state!;
  const box = h("input", { type: "checkbox" });
  box.checked = s.picked.has(c);
  box.onchange = () => ((box.checked ? s.picked.add(c) : s.picked.delete(c)), render());
  const method = c.request.method;
  const path = c.request.url.replace(/^\{\{\s*host\s*\}\}/, "") || "/";
  const detail =
    c.kind === "add"
      ? h("span", { class: "muted" }, [c.route.name, c.route.action].filter(Boolean).join(" · "))
      : c.kind === "update"
        ? h(
            "span",
            { class: "http-sync-fields" },
            ...c.added.map((f) => h("ins", { title: "Added" }, `+ ${f}`)),
            ...c.removed.map((f) => h("del", { title: "Removed" }, `− ${f}`)),
          )
        : h("span", { class: "muted" }, c.request.title && c.request.title !== `${c.request.method} ${c.request.url}` ? c.request.title : "Deleting removes the request from the file.");
  const label = h("label", { class: `row http-sync-row${box.checked ? "" : " off"}` }, box, h("span", { class: "http-badge", data: { method } }, method), h("span", { class: "name" }, path), detail);
  // A request already in the file opens, to look at it first.
  if (c.kind !== "add") {
    const open = h("button", { class: "icon-button", title: "Open the request", ariaLabel: "Open the request", onclick: (e: MouseEvent) => (e.preventDefault(), openRequest(s.path, c.request.line, false, true)) }, icon("go-to-file"));
    label.append(open);
  }
  return h("li", {}, label);
}

/** The ticked changes as line edits, worked out again if the file changed since they were listed. */
async function pickedEdits(): Promise<{ model: monaco.editor.ITextModel; edits: LineEdit[]; picked: SyncChange[] } | null> {
  if (!state) return null;
  const model = await host.ensureModel(state.path);
  if (model.getVersionId() !== state.version) {
    compute(model);
    render();
    host.status(`${relative(state.path)} changed since the list was made, so it's been updated. Check it and apply again.`);
    return null;
  }
  const picked = state.changes.filter((c) => state!.picked.has(c));
  return { model, edits: syncEdits(model.getValue(), picked), picked };
}

async function showDiff() {
  const p = await pickedEdits();
  if (!p || !state) return;
  const before = p.model.getValue();
  host.showDiff(state.path, before, applyLineEdits(before, p.edits), `${relative(state.path)}: sync with routes`);
}

/** A line edit as a Monaco edit, doing to the model what `applyLineEdits` does to text. */
function toMonaco(model: monaco.editor.ITextModel, e: LineEdit): monaco.editor.IIdentifiedSingleEditOperation {
  const count = model.getLineCount();
  const maxColumn = (line: number) => model.getLineMaxColumn(line);
  if (e.end < e.start) {
    if (e.start > count) return { range: monaco.Range.fromPositions(model.getFullModelRange().getEndPosition()), text: `\n${e.lines.join("\n")}` };
    return { range: new monaco.Range(e.start, 1, e.start, 1), text: `${e.lines.join("\n")}\n` };
  }
  if (e.lines.length) return { range: new monaco.Range(e.start, 1, e.end, maxColumn(e.end)), text: e.lines.join("\n") };
  if (e.end < count) return { range: new monaco.Range(e.start, 1, e.end + 1, 1), text: "" };
  if (e.start > 1) return { range: new monaco.Range(e.start - 1, maxColumn(e.start - 1), e.end, maxColumn(e.end)), text: "" };
  return { range: model.getFullModelRange(), text: "" };
}

async function applyPicked() {
  const p = await pickedEdits();
  if (!p || !state || !p.edits.length) return;
  const { model, edits, picked } = p;
  const path = state.path;
  const dirty = host.isDirty(path);
  // Deleted requests' tabs close first; the others follow their requests through the edit.
  for (const c of picked) if (c.kind === "remove") await dropTabsIn(model, c.request.start, c.request.end);
  model.pushEditOperations([], edits.map((e) => toMonaco(model, e)), () => null);
  // One undo in the editor takes the whole sync back.
  model.pushStackElement();
  const saved = dirty ? false : await host.save(path);
  refreshRequestTabs();
  refreshTree();
  const count = (kind: SyncChange["kind"]) => picked.filter((c) => c.kind === kind).length;
  const parts = [count("add") && `${count("add")} added`, count("update") && `${count("update")} updated`, count("remove") && `${count("remove")} deleted`].filter(Boolean);
  const summary = `Synced ${relative(path)}: ${parts.join(", ")}.${dirty ? " The file had unsaved changes, so it's still unsaved." : saved ? "" : " It couldn't be saved."}`;
  host.status(summary);
  compute(model);
  state.done = summary;
  render();
}
