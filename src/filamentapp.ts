// What the designers know about the open project: Filament's catalog, the panels with their resources, the models,
// the enums, and the migrations, each read with introspect.php and kept until the project's code changes. Also runs
// Artisan's generators, in the project's container when it's up, and reports the files they made.
import { invoke } from "@tauri-apps/api/core";
import type { Catalog } from "./filamentcatalog";
import type { Column, ModelFacts, Relation } from "./filamentgen";
import { titleAttribute } from "./filamentgen";
import { tuskRequest } from "./lsp";
import type { Outline } from "./phpcode";
import { pathsFor, psr4From } from "./psr4";
import { runningContainer } from "./sail";
import { commandError } from "./laravelnewdata";

export type PageInfo = { name: string; class: string; file: string | null; kind: "list" | "create" | "edit" | "view" | "manage" | "related" | "custom" };
export type RelationInfo = { class: string; file: string | null; relationship: string | null; title: string | null; group: string | null };
export type ResourceInfo = {
  class: string;
  file: string | null;
  model: string;
  modelFile: string | null;
  label: string | null;
  pluralLabel: string | null;
  navigationLabel: string | null;
  navigationGroup: string | null;
  navigationIcon: string | null;
  navigationSort: number | null;
  slug: string | null;
  cluster: string | null;
  softDeletes: boolean;
  pages: PageInfo[];
  relations: RelationInfo[];
  error?: string;
};
export type PanelInfo = {
  id: string;
  path: string;
  default: boolean;
  provider: { class: string; file: string | null } | null;
  resourceDirs: string[];
  resourceNamespaces: string[];
  clusterDirs: string[];
  clusterNamespaces: string[];
  widgetDirs: string[];
  widgetNamespaces: string[];
  pageDirs: string[];
  pageNamespaces: string[];
  url: string | null;
  resources: ResourceInfo[];
  clusters: { class: string; file: string | null; label: string | null }[];
  pages: { class: string; file: string | null; label: string | null; navigationIcon: string | null; navigationGroup: string | null; navigationSort: number | null }[];
};
export type AppInfo = {
  version: string | null;
  booted: boolean;
  /** Why the app couldn't boot, such as a syntax error in a resource Filament discovers. */
  bootError?: { message: string; file: string; line: number } | null;
  panels: PanelInfo[];
  /** The resource files, read from the source, when the app couldn't boot. */
  files?: { class: string; file: string }[];
};
export type EnumInfo = { class: string; file: string | null; backed: boolean; cases: { name: string; value: string | number | null }[]; contracts: string[] };
export type ModelSummary = { class: string; table: string; keyType?: string; ulid?: boolean; columns: Record<string, { type: string; nullable: boolean } | null>; casts: Record<string, string>; relations: Relation[] };
export type ModelDetails = {
  class: string;
  file: string | null;
  table: string;
  connection: string | null;
  tableExists: boolean | null;
  columns: (Column & { comment?: string | null })[] | null;
  indexes: { name: string; columns: string[]; unique: boolean; primary: boolean }[];
  foreignKeys: { columns: string[]; foreignTable: string; foreignColumns: string[]; onDelete: string | null }[];
  keyName: string;
  keyType: string;
  incrementing: boolean;
  timestamps: boolean;
  softDeletes: boolean;
  fillable: string[];
  guarded: string[];
  hidden: string[];
  casts: Record<string, string>;
  relations: (Relation & { file?: string; line?: number })[];
  factory: boolean;
};
export type PolicyInfo = {
  policy: string | null;
  file: string | null;
  user: string | null;
  spatie: boolean;
  hasRoles: boolean;
  shield: boolean;
  roles: { name: string; permissions: string[] }[];
  permissions: string[];
  error: string | null;
  /** With Filament Shield: the resource's permission keys by ability, its naming, and its super admin role. */
  shieldKeys?: Record<string, string> | null;
  shieldFormat?: { separator: string; case: string } | null;
  superAdmin?: { name: string; viaGate: boolean } | null;
};
export type Migrations = { database: boolean; files: { name: string; file: string; ran: boolean | null }[] };

let project = "";
const cache = new Map<string, Promise<unknown>>();

/** Forgets what was read, for another project or after the code changed. `kinds` limits it, such as to the app. */
export function forget(kinds?: string[]) {
  for (const key of [...cache.keys()]) if (!kinds || kinds.some((k) => key.startsWith(k))) cache.delete(key);
}

/** Runs introspect.php in `mode` and returns its JSON, or throws its error. */
async function introspect<T>(root: string, mode: string, ...args: string[]): Promise<T> {
  const script = await invoke<string>("tool_path", { name: "introspect.php" });
  const out = await invoke<string>("run_capture", { cwd: root, program: "php", args: [script, root, mode, ...args], input: null, anyStatus: true });
  let json: unknown;
  try {
    // Anything a package prints before the JSON, such as a notice, is skipped.
    const start = out.search(/^[[{]/m);
    json = JSON.parse(start > 0 ? out.slice(start) : out);
  } catch {
    // PHP's own errors, such as a syntax error in a provider, come before any JSON.
    console.error(`introspect.php ${mode} failed:\n${out}`);
    throw new Error(out.trim() ? commandError(out) : `introspect.php ${mode} printed nothing`);
  }
  if (json && typeof json === "object" && "error" in json && Object.keys(json).length === 1) throw new Error(String((json as { error: string }).error));
  return json as T;
}

function cached<T>(root: string, key: string, load: () => Promise<T>): Promise<T> {
  if (project !== root) forget(), (project = root);
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export const catalog = (root: string) => cached(root, "catalog", () => introspect<Catalog>(root, "filament-catalog"));
export const app = (root: string) => cached(root, "app", () => introspect<AppInfo>(root, "filament-app"));
export const enums = (root: string) => cached(root, "enums", () => introspect<EnumInfo[]>(root, "enums"));
export const models = (root: string) => cached(root, "models", () => introspect<Record<string, ModelSummary>>(root, "models"));
export const migrations = (root: string) => cached(root, "migrations", () => introspect<Migrations>(root, "migrations"));
export const translations = (root: string) => cached(root, "translations", () => introspect<import("./translations").Translations>(root, "translations"));
export const panelOptions = (root: string) => cached(root, "panel-options", () => introspect<import("./panelsettings").PanelOptions>(root, "panel-options"));
export type WidgetInfo = { class: string; file: string | null; kind: "stats" | "chart" | "table" | "other"; sort: number | null; columnSpan: number | string | Record<string, number | string> | null; heading: string | null; discovered: boolean };
export const widgets = (root: string, panel: string) => cached(root, `app:widgets:${panel}`, () => introspect<{ widgets: WidgetInfo[]; dashboards: { class: string; file: string | null; title: string | null; columns: number | Record<string, number>; widgets: WidgetInfo[] | null }[]; hidden: WidgetInfo[] }>(root, "widgets", panel));
/** What a stats or chart widget shows now, from running it as the first user; not kept, since the data changes. */
export const widgetData = (root: string, cls: string) => introspect<{ as: string | null; stats?: { label: string | null; value: string | null; chart: number[] | null }[]; chart?: { datasets?: { data?: unknown[]; label?: string }[]; labels?: unknown[] }; type?: string }>(root, "widget-data", cls);
export const policy = (root: string, cls: string, resource?: string) => cached(root, `policy:${cls}:${resource ?? ""}`, () => introspect<PolicyInfo>(root, "policy", cls, ...(resource ? [resource] : [])));
/** Who can open a custom page or see a widget; with Shield, the permission it gives the class. */
export const entryAccess = (root: string, cls: string) => cached(root, `policy:entry:${cls}`, () => introspect<PolicyInfo & { shieldKey: string | null }>(root, "entry-access", cls));
/** The app's importers and exporters, and the tables and queue imports and exports need. */
export type PorterInfo = { class: string; file: string | null; model: string | null };
export const porters = (root: string) => cached(root, "app:porters", () => introspect<{ importers: PorterInfo[]; exporters: PorterInfo[]; tables: Record<string, boolean | null>; queue: string | null }>(root, "porters"));
/** The app's notification classes: the record each one's constructor takes, and its channels when `via()` says without a user. */
export type NotificationInfo = { class: string; file: string | null; record: string | null; channels: string[] | null };
export const notifications = (root: string) => cached(root, "app:notifications", () => introspect<NotificationInfo[]>(root, "notifications"));
/** The config values the booted app uses for `keys`, and the mailers, queues, disks, stores, and tables `.env` chooses between. */
export type EnvSettingsInfo = { values: Record<string, unknown>; mailers: Record<string, string | null>; queues: Record<string, string | null>; disks: Record<string, string | null>; stores: Record<string, string | null>; tables: Record<"jobs" | "sessions" | "cache", [string, boolean | null]>; configCached: boolean };
export const envSettings = (root: string, keys: string[]) => cached(root, "env-settings", () => introspect<EnvSettingsInfo>(root, "env-settings", ...keys));
/** Creates a permission or role, or grants or revokes a role's permission: `["grant", "editor", "update_post"]`. */
export const changePermission = (root: string, args: string[]) => introspect<{ ok: boolean }>(root, "permission", ...args);
export const model = (root: string, cls: string) => cached(root, `model:${cls}`, () => introspect<ModelDetails>(root, "model", cls));

/** Whether the project has Filament installed. */
export const hasFilament = (root: string) => invoke<boolean>("path_exists", { path: `${root}/vendor/filament/filament` }).catch(() => false);

/**
 * What the generators need to know about a model: its columns (from the database, or from its declarations when the
 * database can't be read), casts, relationships, and the title attribute of each related model.
 */
export async function modelFacts(root: string, cls: string): Promise<ModelFacts & { details: ModelDetails }> {
  const [details, all, appEnums] = await Promise.all([model(root, cls), models(root).catch(() => ({}) as Record<string, ModelSummary>), enums(root).catch(() => [])]);
  const columns: Column[] =
    details.columns ??
    [details.keyName, ...details.fillable, ...Object.keys(details.casts), ...(details.timestamps ? ["created_at", "updated_at"] : [])]
      .filter((c, i, list) => list.indexOf(c) === i)
      .map((name) => ({ name, type: guessType(name, details.casts[name]), nullable: true, autoIncrement: name === details.keyName && details.incrementing }));
  const titles: Record<string, string> = {};
  for (const r of details.relations) if (r.related && all[r.related]) titles[r.related] = titleAttribute(Object.keys(all[r.related].columns), typesOf(all[r.related]));
  return { class: cls, columns, casts: details.casts, relations: details.relations, enums: appEnums.map((e) => e.class), softDeletes: details.softDeletes, titles, details };
}

/** A model summary's column types, by name. */
export const typesOf = (m: ModelSummary) => Object.fromEntries(Object.entries(m.columns).map(([k, v]) => [k, v?.type]));

/** A column's type from its cast, for a model whose table can't be read. */
function guessType(name: string, cast?: string): string {
  if (!cast) return /_at$/.test(name) ? "timestamp" : /_id$/.test(name) ? "bigint" : "varchar";
  if (/^(bool|boolean)$/.test(cast)) return "boolean";
  if (/^(int|integer)$/.test(cast)) return "integer";
  if (/^(float|double|decimal)/.test(cast)) return "decimal";
  if (/date/.test(cast)) return /time/.test(cast) || cast === "datetime" ? "timestamp" : "date";
  if (/array|json|collection|object/.test(cast)) return "json";
  return "varchar";
}

// ---- Code ----

/** The outline of PHP text, from Tusk's server. */
export async function outlineOf(text: string, path?: string): Promise<Outline> {
  const outline = await tuskRequest<Outline>("tusk/phpOutline", { text, path });
  if (!outline) throw new Error("The PHP server isn't running.");
  return outline;
}

let psr4Cache: { root: string; map: ReturnType<typeof psr4From> } | undefined;

/** The file a class is declared in, through composer.json's PSR-4 folders, or null when none exists. */
export async function fileOfClass(root: string, fqn: string): Promise<string | null> {
  if (psr4Cache?.root !== root) {
    const json = await invoke<string>("read_file", { path: `${root}/composer.json` }).catch(() => "{}");
    psr4Cache = { root, map: psr4From(json) };
  }
  for (const rel of pathsFor(fqn.replace(/^\\/, ""), psr4Cache.map)) if (await invoke<boolean>("path_exists", { path: `${root}/${rel}` })) return `${root}/${rel}`;
  return null;
}

// ---- Artisan ----

/** Runs Artisan with `args` in the project's container when it's up, and returns its output. Throws when it fails. */
export async function artisan(root: string, args: string[]): Promise<string> {
  const container = await runningContainer(root);
  const command = container ? container.exec(["php", "artisan", ...args], [], false) : ["php", "artisan", ...args];
  const [program, ...rest] = command;
  return invoke<string>("run_capture", { cwd: root, program, args: [...rest, "--no-interaction", "--no-ansi"], input: null, anyStatus: false }).catch((e) => {
    // The whole output, with its stack trace, goes to the console; the message says what went wrong.
    const out = e instanceof Error ? e.message : String(e);
    console.error(`php artisan ${args.join(" ")} failed:\n${out}`);
    throw new Error(commandError(out));
  });
}

/**
 * The files a generator's output names, as absolute paths: Laravel prints `[app/Models/Post.php]`, and Filament
 * prints class names, such as `[App\Filament\Resources\Posts\PostResource]`, which are found through PSR-4.
 */
export async function createdFiles(root: string, output: string): Promise<string[]> {
  const found: string[] = [];
  const clean = output.replace(/\x1b\[[\d;]*m/g, "");
  for (const m of clean.matchAll(/\[([^\]\n]+)\]/g)) {
    const name = m[1].trim();
    let path: string | null = null;
    if (/\.php$/.test(name)) path = name.startsWith("/") ? name.replace(/^\/var\/www\/html/, root) : `${root}/${name}`;
    else if (/^[A-Z][\w]*(\\[A-Za-z_]\w*)+$/.test(name)) path = await fileOfClass(root, name);
    if (path && !found.includes(path) && (await invoke<boolean>("path_exists", { path }))) found.push(path);
  }
  return found;
}
