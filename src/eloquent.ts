// The properties Eloquent resolves at runtime on the project's models: columns, relationships, and accessors,
// read by introspect.php. Diagnostics use them to tell Laravel's magic from a real mistake.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";

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

const introspect = async (root: string, mode: string) => {
  const script = await invoke<string>("tool_path", { name: "filament-lsp/introspect.php" });
  return invoke<string>("run_capture", { cwd: root, program: "php", args: [script, root, mode], input: null }).then((out) => JSON.parse(out || "{}"), () => ({}));
};

/** The project's root aliases (`DB`), for telling a facade call when the file doesn't import the facade. */
let aliases: { root: string; names: Set<string> } | undefined;

/**
 * Stubs for Laravel's root aliases, such as `class DB extends \Illuminate\Support\Facades\DB {}`: Laravel makes
 * them with class_alias() at runtime, so Phpactor otherwise reports `use DB;` as a class it can't find. Returns the
 * folder to give Phpactor as a stub path, and whether the stubs are new, which needs a full reindex: Phpactor
 * indexes stub paths only in a full build. The first time, it waits for the aliases; later, it returns the folder
 * at once and checks in the background, calling `changed` if they differ.
 */
export async function aliasStubs(root: string, changed: () => void): Promise<{ dir: string; fresh: boolean } | null> {
  if (!(await invoke<boolean>("path_exists", { path: `${root}/artisan` }))) return null;
  const dir = `${await appCacheDir()}/alias-stubs/${root.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const file = `${dir}/aliases.php`;
  const previous = await invoke<string>("read_file", { path: file }).catch(() => null);
  const write = async () => {
    const map: Record<string, string> = await introspect(root, "aliases");
    if ("error" in map) return false;
    // Root names only; a namespaced alias is rare and would need a namespace block of its own.
    const entries = Object.entries(map).filter(([alias, target]) => /^\w+$/.test(alias) && /^[\w\\]+$/.test(target));
    aliases = { root, names: new Set(entries.filter(([, target]) => /\\Facades\\/.test(target)).map(([alias]) => alias)) };
    const text = `<?php\n\n// Laravel's root aliases, which it makes with class_alias() at runtime. Written by the editor for Phpactor.\n\n${entries.map(([alias, target]) => `class ${alias} extends \\${target} {}`).join("\n")}\n`;
    if (text === previous) return false;
    await invoke("create_dir", { path: dir });
    await invoke("write_file", { path: file, contents: text });
    return true;
  };
  if (previous === null) return { dir, fresh: await write().catch(() => false) };
  write().then((differ) => differ && changed(), () => {});
  return { dir, fresh: false };
}

/** Whether a class name used in a file is a facade: a root alias such as `DB`, or a class the file imports from a Facades namespace. */
export function isFacade(name: string, fileText: string): boolean {
  return !!aliases?.names.has(name) || new RegExp(`^use\\s+[\\w\\\\]+\\\\Facades\\\\${name}\\s*;`, "m").test(fileText);
}
