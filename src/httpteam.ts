// Moves requests between the HTTP client and other tools: imports Postman collections, Insomnia exports, and OpenAPI
// or Swagger documents into .http files in http/, and exports the project's requests to OpenAPI.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ENV_FILE, environments, host, ignorePrivateFile, parentOf, PRIVATE_ENV_FILE, selectedEnvironment } from "./httpclient";
import { isSecretName, parseHttp } from "./httpfile";
import { type Environments, type Imported, importCollection, toOpenApi } from "./httpimport";
import { httpFiles, refreshTree, setImporter, showImport } from "./httpview";
import { pick } from "./palette";

/** Asks what to import from, then imports it. */
export function importRequests() {
  const fromFile = (kind: string) => () => importFile(kind);
  pick("Import requests from", () => [
    { label: "cURL command", icon: "codicon-terminal", run: () => showImport() },
    { label: "Postman collection…", icon: "codicon-json", run: fromFile("Postman collection") },
    { label: "Insomnia export…", icon: "codicon-json", run: fromFile("Insomnia export") },
    { label: "OpenAPI or Swagger file…", icon: "codicon-json", run: fromFile("OpenAPI or Swagger file") },
  ]);
}

async function importFile(kind: string) {
  const path = await open({ multiple: false, directory: false, filters: [{ name: `${kind} (JSON or YAML)`, extensions: ["json", "yaml", "yml"] }] });
  if (typeof path !== "string") return;
  let result: Imported;
  try {
    result = importCollection(await invoke<string>("read_file", { path }));
  } catch (e) {
    return host.status(`Couldn't import ${path.split("/").pop()}: ${e instanceof Error ? e.message : e}`);
  }
  const suggested = result.name.toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "imported";
  pick(
    "Name of the new .http file in http/",
    (q) => {
      const name = (q.trim() || suggested).replace(/\.(http|rest)$/, "");
      return [{ label: `Create http/${name}.http`, detail: `${result.count} requests`, icon: "codicon-new-file", run: () => writeImport(name, result) }];
    },
    0,
    { value: suggested },
  );
}

/** Writes the imported file, adding a number to the name when it's taken, and merges its environments. */
async function writeImport(name: string, result: Imported) {
  let path = `${host.root()}/http/${name}.http`;
  for (let n = 2; await invoke<boolean>("path_exists", { path }); n++) path = `${host.root()}/http/${name}-${n}.http`;
  await invoke("create_dir", { path: parentOf(path) }).catch(() => {});
  await invoke("write_file", { path, contents: result.text });
  // Secrets, such as a token, go to the private file, which stays out of the repository.
  const [shared, secret]: Environments[] = [{}, {}];
  for (const [env, vars] of Object.entries(result.env))
    for (const [k, v] of Object.entries(vars)) ((isSecretName(k) ? secret : shared)[env] ??= {})[k] = v;
  const added = (await mergeEnvironments(ENV_FILE, shared)) + (await mergeEnvironments(PRIVATE_ENV_FILE, secret));
  if (Object.keys(secret).length) await ignorePrivateFile();
  refreshTree();
  await host.openAt(path, 1);
  host.status(`Imported ${result.count} requests to ${path.replace(host.root() + "/", "")}${added ? `, and ${added} environment variables` : ""}`);
}

/** Adds variables to an environment file in the project root, keeping values it already has. Returns how many it added. */
async function mergeEnvironments(file: string, envs: Environments) {
  if (!Object.keys(envs).length) return 0;
  const path = `${host.root()}/${file}`;
  const existing = await invoke<string>("read_file", { path })
    .then((t) => JSON.parse(t) as Environments)
    .catch(() => ({}) as Environments);
  let added = 0;
  for (const [env, vars] of Object.entries(envs))
    for (const [k, v] of Object.entries(vars)) {
      existing[env] ??= {};
      if (!Object.hasOwn(existing[env], k)) (existing[env][k] = v), added++;
    }
  if (added) await invoke("write_file", { path, contents: JSON.stringify(existing, null, 2) + "\n" });
  return added;
}

/** Saves the project's requests as an OpenAPI 3.0 document, with the selected environment's host as the server. */
export async function exportOpenApi() {
  const files = await httpFiles();
  if (!files.length) return host.status("There are no .http files in the project to export.");
  const texts = await Promise.all(files.sort().map((f) => invoke<string>("read_file", { path: f }).catch(() => "")));
  const requests = texts.flatMap((t) => parseHttp(t).requests);
  const envs = await environments();
  const server = envs[selectedEnvironment(envs) ?? ""]?.host;
  const to = await save({ defaultPath: `${host.root()}/openapi.json`, filters: [{ name: "OpenAPI (JSON)", extensions: ["json"] }] });
  if (!to) return;
  const title = host.root().split("/").pop() ?? "API";
  await invoke("write_file", { path: to, contents: JSON.stringify(toOpenApi(requests, title, server), null, 2) + "\n" }).then(
    () => host.status(`Exported ${requests.length} requests to ${to}`),
    (e) => host.status(`Couldn't export: ${e}`),
  );
}

setImporter(importRequests);
