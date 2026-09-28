// The Filament tool window: the app's panels with their resources, each opening in the designer, and commands to
// make resources, models, and projects. Also the "Open in Designer" link above a resource's class, and what the
// designers need to hear from the rest of the app, such as the app's files changing.
import { h, icon, iconButton } from "./dom";
import { monaco } from "./editor";
import * as fapp from "./filamentapp";
import { majorVersion } from "./filamentcatalog";
import { initDesigner, openDesigner, projectChanged, type DesignerHost } from "./filamentdesigner";
import { heroicon } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { pick, rank, type Item } from "./palette";
import { errorText } from "./status";
import { toolPath } from "./lsp";
import { composerCommand } from "./toolpaths";
import { shellQuote } from "./runconfig";

let host: DesignerHost & { showView(name: string): void; openTerminal(title: string, command: string[], done?: () => void): void };
const $ = (id: string) => document.getElementById(id)!;
const collapsed = new Set<string>();

export function initFilament(h_: typeof host) {
  host = h_;
  initDesigner(h_);
  $("filament-new").onclick = () => void newResource();
  $("filament-refresh").onclick = () => (fapp.forget(), void loadFilament());
  monaco.languages.registerCodeLensProvider("php", {
    provideCodeLenses(model) {
      const text = model.getValue();
      const m = /^\s*(?:final\s+|abstract\s+)*class\s+(\w+)\s+extends\s+(\w*(?:Resource|RelationManager))\b/m.exec(text);
      const schema = !m && /^\s*(?:final\s+)?class\s+\w+(Form|Table|Infolist)\s*\{/m.exec(text) && /public static function configure\((Schema|Table) \$/.test(text) ? /^\s*(?:final\s+)?class/m.exec(text) : null;
      const found = m ?? schema;
      const modelClass = !found && /^\s*(?:final\s+)?class\s+\w+\s+extends\s+(Model|Authenticatable|Pivot)\b/m.exec(text);
      if (modelClass && /Illuminate\\Database\\Eloquent|Illuminate\\Foundation\\Auth/.test(text)) {
        const line = model.getPositionAt(modelClass.index + modelClass[0].length - modelClass[0].trimStart().length).lineNumber;
        return { lenses: [{ range: new monaco.Range(line, 1, line, 1), command: { id: "tusk.openModelDesigner", title: "Open in Model Designer", arguments: [model.uri.fsPath] } }], dispose() {} };
      }
      if (!found || !/Filament\\/.test(text)) return { lenses: [], dispose() {} };
      const line = model.getPositionAt(found.index + found[0].length - found[0].trimStart().length).lineNumber;
      return { lenses: [{ range: new monaco.Range(line, 1, line, 1), command: { id: "tusk.openDesigner", title: "Open in Designer", arguments: [model.uri.fsPath] } }], dispose() {} };
    },
  });
  monaco.editor.registerCommand("tusk.openDesigner", (_, path: string) => void openFileInDesigner(path));
  monaco.editor.registerCommand("tusk.openModelDesigner", (_, path: string) => void import("./modeldesigner").then((m) => m.openModelDesigner(path)));
}

/** Opens a file in the designer: a resource or relation manager itself, or the resource a schema class belongs to. */
export async function openFileInDesigner(path: string) {
  if (/(Resource|RelationManager)\.php$/.test(path)) return openDesigner(path);
  // Filament 4 keeps PostForm in Posts/Schemas/ and PostsTable in Posts/Tables/, next to Posts/PostResource.php.
  const dir = path.replace(/\/(Schemas|Tables)\/[^/]+$/, "");
  const { invoke } = await import("@tauri-apps/api/core");
  const entries = await invoke<{ name: string; is_dir: boolean }[]>("read_dir", { path: dir }).catch(() => []);
  const resource = entries.find((e) => !e.is_dir && /Resource\.php$/.test(e.name));
  if (resource) return openDesigner(`${dir}/${resource.name}`, /Table/.test(path) ? "table" : /Infolist/.test(path) ? "infolist" : "form");
  host.status("No resource found for this file.");
}

/** Loads the panels and resources into the tool window. */
export async function loadFilament() {
  const root = host.root();
  const list = $("filament-list");
  if (!root) return list.replaceChildren();
  if (!(await fapp.hasFilament(root))) {
    list.replaceChildren(
      h(
        "div",
        { class: "fv-empty" },
        h("p", {}, "Filament isn't installed in this project."),
        h("button", { type: "button", class: "primary", onclick: () => void installFilament() }, icon("cloud-download"), "Install Filament…"),
      ),
    );
    return;
  }
  if (!list.childElementCount) list.replaceChildren(h("p", { class: "fv-empty muted" }, "Reading the panels…"));
  let app: fapp.AppInfo;
  try {
    app = await fapp.app(root);
  } catch (e) {
    list.replaceChildren(h("div", { class: "fv-empty" }, h("p", {}, `Can't read the app: ${errorText(e)}`), h("button", { type: "button", onclick: () => (fapp.forget(), void loadFilament()) }, icon("refresh"), "Try again")));
    return;
  }
  const cat = await fapp.catalog(root).catch(() => null);
  const iconsDir = cat?.heroiconsDir ?? null;
  if (cat && majorVersion(cat) && majorVersion(cat) < 4) {
    list.replaceChildren(h("p", { class: "fv-empty muted" }, `The designers work with Filament 4 and later. This project has ${cat.version}.`));
    return;
  }
  const rows: HTMLElement[] = [];
  for (const panel of app.panels) {
    const open = !collapsed.has(panel.id);
    const head = h(
      "li",
      { class: "fv-panel", role: "treeitem", ariaExpanded: String(open), tabIndex: 0 },
      h("span", { class: `codicon codicon-chevron-${open ? "down" : "right"}` }),
      icon("window"),
      h("span", { class: "fv-name" }, panel.id),
      h("span", { class: "fv-detail" }, `/${panel.path}`),
      h("span", { class: "fv-actions" }, iconButton("add", "New resource in this panel", () => void newResource(panel.id)), ...(panel.url ? [iconButton("link-external", "Open the panel in the browser", () => host.openUrl(panel.url!))] : [])),
    );
    head.onclick = (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (open) collapsed.add(panel.id);
      else collapsed.delete(panel.id);
      void loadFilament();
    };
    rows.push(head);
    if (!open) continue;
    const groups = new Map<string, fapp.ResourceInfo[]>();
    for (const r of panel.resources) {
      const g = r.navigationGroup ?? "";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(r);
    }
    for (const [group, resources] of [...groups.entries()].sort(([a], [b]) => (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b))) {
      if (group) rows.push(h("li", { class: "fv-group" }, group));
      for (const r of resources.sort((a, b) => (a.navigationSort ?? 0) - (b.navigationSort ?? 0) || (a.pluralLabel ?? "").localeCompare(b.pluralLabel ?? ""))) {
        const file = r.file ? `${root}/${r.file}` : null;
        const row = h(
          "li",
          { class: `fv-resource${r.error ? " broken" : ""}`, role: "treeitem", tabIndex: 0, title: r.error ?? `${r.class}\nModel: ${r.model}` },
          r.navigationIcon ? heroicon(iconsDir, r.navigationIcon) : icon("symbol-structure"),
          h("span", { class: "fv-name" }, r.navigationLabel ?? r.pluralLabel ?? shortClass(r.class)),
          h("span", { class: "fv-detail" }, shortClass(r.model ?? "")),
          r.relations.length ? h("span", { class: "fv-badge", title: `${r.relations.length} relation managers` }, icon("references"), String(r.relations.length)) : null,
        );
        row.onclick = () => file && void openDesigner(file);
        row.onkeydown = (e) => e.key === "Enter" && file && void openDesigner(file);
        row.oncontextmenu = (e) => {
          e.preventDefault();
          void import("./files").then(({ showMenu }) =>
            showMenu(e.clientX, e.clientY, [
              { label: "Open in Designer", run: () => file && void openDesigner(file) },
              { label: "Open Code", run: () => file && host.openAt(file, 1) },
              ...(r.modelFile ? [{ label: "Open Model", run: () => void import("./modeldesigner").then((m) => m.openModelDesigner(`${root}/${r.modelFile}`)) }] : []),
              ...(panel.url && r.slug ? [{ label: "Open in Browser", run: () => host.openUrl(`${panel.url}/${r.slug}`) }] : []),
              "-",
              { label: "Design the Form", run: () => file && void openDesigner(file, "form") },
              { label: "Design the Table", run: () => file && void openDesigner(file, "table") },
              { label: "Relation Managers", run: () => file && void openDesigner(file, "relations") },
            ]),
          );
        };
        rows.push(row);
      }
    }
    if (!panel.resources.length) rows.push(h("li", { class: "fv-none muted" }, "No resources yet"));
  }
  if (!app.panels.length) rows.push(h("li", { class: "fv-none muted" }, app.booted ? "No panels. Filament needs a panel provider." : "The app couldn't boot, so its panels aren't known."));
  list.replaceChildren(h("ul", { class: "fv-tree", role: "tree" }, ...rows));
}

/** Picks a resource to open in the designer. */
export async function openResourcePicker() {
  const root = host.root();
  const app = await fapp.app(root).catch((e) => (host.status(`Can't read the app: ${errorText(e)}`), null));
  if (!app) return;
  const items: Item[] = app.panels.flatMap((p) =>
    p.resources.map((r) => ({ label: r.navigationLabel ?? r.pluralLabel ?? shortClass(r.class), detail: `${p.id} · ${shortClass(r.model ?? "")}`, icon: "codicon-symbol-structure", run: () => r.file && void openDesigner(`${root}/${r.file}`) })),
  );
  items.push({ label: "New Resource…", detail: "Create a resource with the wizard", icon: "codicon-add", run: () => void newResource() });
  pick("Open a resource in the designer", (query) => (query.trim() ? rank(query, items) : items));
}

/** Picks a model to open in the model designer, or makes a new one. */
export async function openModelPicker() {
  const root = host.root();
  const models = await fapp.models(root).catch((e) => (host.status(`Can't read the models: ${errorText(e)}`), null));
  if (!models) return;
  const { openModelDesigner, openNewModel } = await import("./modeldesigner");
  const items: Item[] = await Promise.all(
    Object.values(models).map(async (m) => ({ label: shortClass(m.class), detail: `${m.table} · ${Object.keys(m.columns).length} columns`, icon: "codicon-database", run: async () => {
      const file = await fapp.fileOfClass(root, m.class);
      if (file) void openModelDesigner(file);
    } })),
  );
  items.push({ label: "New Model…", detail: "Design a model, its migration, and its factory", icon: "codicon-add", run: () => openNewModel() });
  pick("Open a model in the designer", (query) => (query.trim() ? rank(query, items) : items));
}

export async function newResource(panel?: string) {
  const m = await import("./filamentwizard");
  await m.openResourceWizard({ panel, onCreated: () => (fapp.forget(["app"]), void loadFilament()) });
}

/**
 * Installs Filament in the project in a terminal tab: Composer, then Filament's installer with a panel, then a first
 * user. The installer and the user command ask their questions in the terminal.
 */
export async function installFilament() {
  const composer = composerCommand(await toolPath("composer/composer.phar")).map(shellQuote).join(" ");
  const line = `${composer} require filament/filament --no-interaction && php artisan filament:install --panels && php artisan make:filament-user`;
  host.openTerminal("Install Filament", ["/bin/sh", "-c", line], () => (fapp.forget(), void loadFilament()));
}

/** The app's code changed on disk: what introspect.php read may be stale. */
export function filamentFilesChanged(paths: string[]) {
  const root = host.root();
  if (!paths.some((p) => p.startsWith(`${root}/app/`) || p.startsWith(`${root}/database/`) || p.endsWith("/composer.lock"))) return;
  fapp.forget(paths.some((p) => p.endsWith("/composer.lock")) ? undefined : ["app", "models", "model:", "enums", "migrations"]);
  projectChanged();
  if (!$("view-filament").hidden) void loadFilament();
}
