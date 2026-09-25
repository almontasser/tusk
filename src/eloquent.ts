// The properties Eloquent resolves at runtime on the project's models: columns, relationships, and accessors,
// read by introspect.php. Diagnostics use them to tell Laravel's magic from a real mistake.
import { invoke } from "@tauri-apps/api/core";

type ModelFacts = { columns: Record<string, unknown>; relations: { name: string }[]; accessors?: string[]; scopes?: string[] };

/**
 * For the open project, once read: property names by model class (columns, relationships, accessors), method names
 * by model class (local scopes), and the query builder methods every model forwards calls to.
 */
let properties: { root: string; byClass: Map<string, Set<string>>; methods: Map<string, Set<string>>; builder: Set<string> } | undefined;
let reading: { root: string; done: Promise<void> } | undefined;
/** Each read's number, so a slower, older read doesn't replace a newer one. */
let reads = 0;
const listeners: (() => void)[] = [];

/** Runs `listener` whenever the models have been read again, so diagnostics can be filtered with them. */
export const onModelsRead = (listener: () => void) => listeners.push(listener);

/** Reads the project's models. It boots the app to read columns from the database, which takes about half a second. */
export function readModels(root: string) {
  if (reading?.root === root) return reading.done;
  const read = ++reads;
  const done = (async () => {
    if (!(await invoke<boolean>("path_exists", { path: `${root}/artisan` }))) return;
    const script = await invoke<string>("tool_path", { name: "filament-lsp/introspect.php" });
    const introspect = (mode: string) => invoke<string>("run_capture", { cwd: root, program: "php", args: [script, root, mode], input: null }).then((out) => JSON.parse(out || "{}"), () => ({}));
    const [models, builder]: [Record<string, ModelFacts> | { error: string }, string[] | { error: string }] = await Promise.all([introspect("models"), introspect("builder")]);
    if ("error" in models) return;
    const byClass = new Map<string, Set<string>>();
    const methods = new Map<string, Set<string>>();
    for (const [name, m] of Object.entries(models)) {
      byClass.set(name, new Set([...Object.keys(m.columns ?? {}), ...(m.relations ?? []).map((r) => r.name), ...(m.accessors ?? [])]));
      methods.set(name, new Set(m.scopes ?? []));
    }
    if (read !== reads) return; // Another project, or a newer read, took over.
    properties = { root, byClass, methods, builder: new Set(Array.isArray(builder) ? builder : []) };
    listeners.forEach((l) => l());
  })().catch(() => {});
  reading = { root, done };
  return done;
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Reads the models again soon, such as after a model or a migration is saved. */
export function rereadModels(root: string) {
  clearTimeout(timer);
  timer = setTimeout(() => ((reading = undefined), readModels(root)), 1500);
}

/**
 * Whether `property` is one Eloquent gives `className`: a column, a relationship, or an accessor. Undefined while
 * the models haven't been read, or for a class that isn't a model.
 */
export function isModelProperty(className: string, property: string): boolean | undefined {
  const known = properties?.byClass.get(className.replace(/^\\/, ""));
  return known ? known.has(property) : undefined;
}

/**
 * Whether `method` is one a model answers through Eloquent: a local scope, or a query builder method it forwards,
 * such as `create` or `where`. Undefined while the models haven't been read, or for a class that isn't a model.
 */
export function isModelMethod(className: string, method: string): boolean | undefined {
  const scopes = properties?.methods.get(className.replace(/^\\/, ""));
  return scopes ? scopes.has(method) || properties!.builder.has(method) : undefined;
}
